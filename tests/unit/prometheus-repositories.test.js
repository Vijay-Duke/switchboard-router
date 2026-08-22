import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let usageRepo;
let routingRepo;
let cacheRepo;
let connectionsRepo;
let nodesRepo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-prometheus-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const database = await import("../../src/lib/db/index.js");
  await database.initDb();
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  db = await getAdapter();
  usageRepo = await import("../../src/lib/db/repos/usageRepo.js");
  routingRepo = await import("../../src/lib/db/repos/routingRepo.js");
  connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
  nodesRepo = await import("../../src/lib/db/repos/nodesRepo.js");
  cacheRepo = await import("../../src/lib/db/repos/fetchCacheRepo.js");
});

beforeEach(() => {
  db.run("UPDATE prometheusMetricState SET available = 1 WHERE id = 1");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Prometheus repository snapshots", () => {
  it("reads only compact usage rows and ignores high-cardinality daily JSON", async () => {
    db.run("DELETE FROM usageDaily");
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      "2026-08-22",
      "{malformed high-cardinality data that scrapes must not read",
    ]);
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES(?, ?, ?, ?, ?, ?)`,
      ["openai", 3, 30, 12, 5, 3],
    );
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES(?, ?, ?, ?, ?, ?)`,
      ["unknown", 1, 10, 4, 0, 1.5],
    );

    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "openai", requests: 3, promptTokens: 30, completionTokens: 12, cachedTokens: 5, cost: 3 },
        { provider: "unknown", requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 0, cost: 1.5 },
      ],
    });
  });

  it("updates compact lifetime usage in the same write path", async () => {
    db.run("DELETE FROM usageDaily");
    db.run("DELETE FROM usageHistory");
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("DELETE FROM providerConnections");
    const now = "2026-08-22T00:00:00.000Z";
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt)
       VALUES('openai-connection', 'openai', 'apikey', 1, '{}', ?, ?)`,
      [now, now],
    );
    await usageRepo.saveRequestUsage({
      timestamp: now,
      requestId: "metric-write-openai",
      provider: "openai",
      model: "secret-model",
      tokens: { prompt_tokens: 7, completion_tokens: 3, cached_tokens: 2 },
    });
    await usageRepo.saveRequestUsage({
      timestamp: now,
      requestId: "metric-write-retired",
      provider: "retired-provider",
      model: "secret-model",
      tokens: { prompt_tokens: 5, completion_tokens: 1 },
    });

    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "openai", requests: 1, promptTokens: 7, completionTokens: 3, cachedTokens: 2, cost: 0 },
        { provider: "unknown", requests: 1, promptTokens: 5, completionTokens: 1, cachedTokens: 0, cost: 0 },
      ],
    });
  });

  it("rejects non-decimal, fractional, and negative compact usage values", async () => {
    for (const [field, value] of [
      ["requests", " "],
      ["requests", "0x10"],
      ["requests", 1.5],
      ["promptTokens", 1.5],
      ["completionTokens", -1],
      ["cost", "not-a-number"],
      ["cost", -0.5],
    ]) {
      db.run("DELETE FROM prometheusUsageTotals");
      db.run(
        `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
         VALUES('openai', 1, 2, 3, 0, 0.5)`,
      );
      db.run(`UPDATE prometheusUsageTotals SET ${field} = ? WHERE provider = 'openai'`, [value]);
      await expect(usageRepo.getUsageMetricTotals()).rejects.toThrow("invalid Prometheus usage metric");
    }
  });

  it("preserves corrupt usage aggregates and disables metrics while core writes continue", async () => {
    db.run("DELETE FROM usageHistory");
    for (const [index, value] of [" ", "text", "0x10", 1.5, -1].entries()) {
      db.run("UPDATE prometheusMetricState SET available = 1 WHERE id = 1");
      db.run("DELETE FROM prometheusUsageTotals");
      db.run(
        `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
         VALUES('openai', ?, 2, 3, 0, 0.5)`,
        [value],
      );
      const before = db.get("SELECT COUNT(*) AS count FROM usageHistory").count;

      await usageRepo.saveRequestUsage({
        timestamp: `2026-08-22T00:00:0${index}.000Z`,
        requestId: `corrupt-metric-write-${index}`,
        provider: "openai",
        model: "secret-model",
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
      });

      expect(db.get("SELECT COUNT(*) AS count FROM usageHistory").count).toBe(before + 1);
      expect(db.get("SELECT requests FROM prometheusUsageTotals WHERE provider = 'openai'").requests).toBe(value);
      expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);
      await expect(usageRepo.getUsageMetricTotals()).rejects.toThrow("Prometheus metrics unavailable");
    }
  });



  it("collapses a deleted provider's lifetime row into unknown", async () => {
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("DELETE FROM providerConnections");
    const now = "2026-08-22T00:00:00.000Z";
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt)
       VALUES('retired-connection', 'retired-provider', 'apikey', 1, '{}', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES('retired-provider', 2, 20, 8, 1, 2), ('unknown', 1, 5, 2, 0, 0.5)`,
    );

    expect(await connectionsRepo.deleteProviderConnection("retired-connection")).toBe(true);
    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "unknown", requests: 3, promptTokens: 25, completionTokens: 10, cachedTokens: 1, cost: 2.5 },
      ],
    });
  });

  it("keeps built-in provider totals after the last connection is deleted", async () => {
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("DELETE FROM providerConnections");
    const now = "2026-08-22T00:00:00.000Z";
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt)
       VALUES('anthropic-connection', 'anthropic', 'apikey', 1, '{}', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES('anthropic', 2, 20, 8, 1, 2)`,
    );

    expect(await connectionsRepo.deleteProviderConnection("anthropic-connection")).toBe(true);
    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "anthropic", requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 1, cost: 2 },
      ],
    });
  });

  it("collapses a deleted custom provider-node total into unknown", async () => {
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("DELETE FROM providerNodes");
    const now = "2026-08-22T00:00:00.000Z";
    db.run(
      `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
       VALUES('custom-node', 'llm', 'Custom', '{}', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES('custom-node', 2, 20, 8, 1, 2)`,
    );

    expect((await nodesRepo.deleteProviderNode("custom-node")).id).toBe("custom-node");
    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "unknown", requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 1, cost: 2 },
      ],
    });
  });

  it("does not coerce corrupt provider totals during retirement", async () => {
    db.run("UPDATE prometheusMetricState SET available = 1 WHERE id = 1");
    db.run("DELETE FROM prometheusUsageTotals");
    db.run("DELETE FROM providerConnections");
    const now = "2026-08-22T00:00:00.000Z";
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt)
       VALUES('corrupt-retirement', 'custom-retirement', 'apikey', 1, '{}', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
       VALUES('custom-retirement', 2, 20, 8, 1, 2), ('unknown', ' ', 5, 2, 0, 0.5)`,
    );

    expect(await connectionsRepo.deleteProviderConnection("corrupt-retirement")).toBe(true);
    expect(db.get("SELECT requests FROM prometheusUsageTotals WHERE provider = 'custom-retirement'").requests).toBe(2);
    expect(db.get("SELECT requests FROM prometheusUsageTotals WHERE provider = 'unknown'").requests).toBe(" ");
    expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);
  });


  it("reports routing retention as a snapshot and excludes skipped/non-terminal attempts", async () => {
    db.run("DELETE FROM routing_events");
    db.run("DELETE FROM prometheusRoutingRequests");
    db.run("UPDATE prometheusRoutingTotals SET requests = 0, errors = 0, fallbacks = 0");
    await routingRepo.insertRoutingEvent({
      comboName: "secret-combo", requestId: "r1", pickedWorker: "secret-model",
      routerReason: "router", workerStatus: 200, meta: { terminal: true },
    });
    await routingRepo.insertRoutingEvent({
      comboName: "secret-combo", requestId: "r2", pickedWorker: "secret-model",
      routerReason: "retry", workerStatus: 502, fallbackUsed: true, meta: { terminal: true },
    });
    await routingRepo.insertRoutingEvent({
      comboName: "secret-combo", requestId: "r3", pickedWorker: "secret-model",
      routerReason: "exploration:0.1", workerStatus: 200, meta: { terminal: true },
    });
    await routingRepo.insertRoutingEvent({
      comboName: "secret-combo", requestId: "r4", pickedWorker: "secret-model",
      routerReason: "cached_route", workerStatus: 500, meta: { terminal: false },
    });
    await routingRepo.insertRoutingEvent({
      comboName: "secret-combo", requestId: "r5", pickedWorker: "secret-model",
      routerReason: "bandit_policy", workerStatus: 500, meta: { terminal: true, skippedRouter: true },
    });

    const result = await routingRepo.getRoutingMetricSnapshot();
    expect(result).toEqual({
      retainedRequests: 3,
      retainedErrors: 1,
      retainedFallbacks: 1,
      autoDecisions: {
        router: 1,
        bandit_policy: 0,
        cached_route: 0,
        exploration: 1,
        judge_flag_escalation: 0,
        fallback_rescue: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-combo");
    expect(JSON.stringify(result)).not.toContain("secret-model");

    expect(await routingRepo.deleteRoutingDataForCombo("secret-combo")).toEqual({ events: 5, versions: 0 });
    expect(await routingRepo.getRoutingMetricSnapshot()).toEqual({
      retainedRequests: 0,
      retainedErrors: 0,
      retainedFallbacks: 0,
      autoDecisions: {
        router: 0,
        bandit_policy: 0,
        cached_route: 0,
        exploration: 0,
        judge_flag_escalation: 0,
        fallback_rescue: 0,
      },
    });
  });

  it("rejects non-decimal, fractional, and negative compact routing values", async () => {
    for (const value of [" ", "0x10", 1.5, -1]) {
      db.run("UPDATE prometheusRoutingTotals SET requests = 0");
      db.run("UPDATE prometheusRoutingTotals SET requests = ? WHERE source = 'router'", [value]);
      await expect(routingRepo.getRoutingMetricSnapshot()).rejects.toThrow("invalid Prometheus routing metric");
    }
  });

  it("preserves corrupt routing totals and disables metrics while inserts continue", async () => {
    for (const [index, value] of [" ", "text", "0x10", 1.5, -1].entries()) {
      db.run("UPDATE prometheusMetricState SET available = 1 WHERE id = 1");
      db.run("DELETE FROM routing_events");
      db.run("DELETE FROM prometheusRoutingRequests");
      db.run("UPDATE prometheusRoutingTotals SET requests = 0, errors = 0, fallbacks = 0");
      db.run("UPDATE prometheusRoutingTotals SET requests = ? WHERE source = 'router'", [value]);

      await routingRepo.insertRoutingEvent({
        comboName: "corrupt-routing",
        requestId: `corrupt-routing-${index}`,
        routerReason: "router",
        workerStatus: 200,
        meta: { terminal: true },
      });

      expect(db.get("SELECT COUNT(*) AS count FROM routing_events").count).toBe(1);
      expect(db.get("SELECT requests FROM prometheusRoutingTotals WHERE source = 'router'").requests).toBe(value);
      expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);
      await expect(routingRepo.getRoutingMetricSnapshot()).rejects.toThrow("Prometheus metrics unavailable");
    }
  });

  it("does not partially decrement corrupt routing state during core deletion", async () => {
    db.run("UPDATE prometheusMetricState SET available = 1 WHERE id = 1");
    db.run("DELETE FROM routing_events");
    db.run("DELETE FROM prometheusRoutingRequests");
    db.run("UPDATE prometheusRoutingTotals SET requests = 0, errors = 0, fallbacks = 0");
    await routingRepo.insertRoutingEvent({
      comboName: "corrupt-delete",
      requestId: "corrupt-delete-request",
      routerReason: "router",
      workerStatus: 200,
      meta: { terminal: true },
    });
    db.run("UPDATE prometheusRoutingTotals SET errors = ' ' WHERE source = 'router'");

    expect(await routingRepo.deleteRoutingDataForCombo("corrupt-delete")).toEqual({ events: 1, versions: 0 });
    expect(db.get("SELECT errors FROM prometheusRoutingTotals WHERE source = 'router'").errors).toBe(" ");
    expect(db.get("SELECT requestKey FROM prometheusRoutingRequests WHERE requestKey = 'corrupt-delete-request'")).toBeTruthy();
    expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);
  });

  it("reports active request counts without account or model dimensions", async () => {
    usageRepo.trackPendingRequest("secret-model", "openai", "secret-connection", true);
    try {
      expect(await usageRepo.getActiveRequestMetricSnapshot()).toEqual({
        activeRequests: [{ provider: "openai", count: 1 }],
      });
    } finally {
      usageRepo.trackPendingRequest("secret-model", "openai", "secret-connection", false);
    }
  });

  it("counts only unexpired cache occupancy", async () => {
    db.run("DELETE FROM fetchCache");
    const now = new Date("2026-08-22T12:00:00.000Z");
    const row = (key, size, expiresAt) => [
      key, "fetch", "https://example.invalid", "x", "text/plain", size,
      "2026-08-22T00:00:00.000Z", expiresAt, "2026-08-22T00:00:00.000Z",
    ];
    db.run("INSERT INTO fetchCache(cacheKey,kind,url,content,contentType,sizeBytes,createdAt,expiresAt,lastAccessedAt) VALUES(?,?,?,?,?,?,?,?,?)", row("live", 9, "2026-08-23T00:00:00.000Z"));
    db.run("INSERT INTO fetchCache(cacheKey,kind,url,content,contentType,sizeBytes,createdAt,expiresAt,lastAccessedAt) VALUES(?,?,?,?,?,?,?,?,?)", row("expired", 99, "2026-08-21T00:00:00.000Z"));

    expect(await cacheRepo.getFetchCacheMetricSnapshot(now)).toEqual({ entries: 1, bytes: 9 });
  });

  it("rejects text and fractional cache occupancy values", async () => {
    for (const size of ["not-a-number", 1.5]) {
      db.run("DELETE FROM fetchCache");
      db.run(
        `INSERT INTO fetchCache(cacheKey, kind, content, sizeBytes, createdAt, expiresAt, lastAccessedAt)
         VALUES('corrupt', 'fetch', 'x', ?, ?, ?, ?)`,
        [
          size,
          "2026-08-22T00:00:00.000Z",
          "2026-08-23T00:00:00.000Z",
          "2026-08-22T00:00:00.000Z",
        ],
      );
      await expect(cacheRepo.getFetchCacheMetricSnapshot(new Date("2026-08-22T12:00:00.000Z")))
        .rejects.toThrow("invalid Prometheus cache metric");
    }
  });
});
