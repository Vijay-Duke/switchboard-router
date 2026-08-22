import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let usageRepo;
let routingRepo;
let cacheRepo;

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
  cacheRepo = await import("../../src/lib/db/repos/fetchCacheRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Prometheus repository snapshots", () => {
  it("aggregates lifetime usage only by provider and ignores client-key dimensions", async () => {
    db.run("DELETE FROM usageDaily");
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      "2026-08-21",
      JSON.stringify({
        requests: 3, promptTokens: 30, completionTokens: 12, cachedTokens: 4, cost: 3,
        byProvider: {
          openai: { requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 4, cost: 2 },
        },
        byClientKey: {
          "safe-id-but-not-a-metric-label": { requests: 3, promptTokens: 30 },
        },
      }),
    ]);
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      "2026-08-22",
      JSON.stringify({
        requests: 2, promptTokens: 15, completionTokens: 6, cachedTokens: 1, cost: 2,
        byProvider: {
          openai: { requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 1, cost: 1 },
          anthropic: { requests: 1, promptTokens: 5, completionTokens: 2, cachedTokens: 0, cost: 0.5 },
        },
      }),
    ]);

    const result = await usageRepo.getUsageMetricTotals();
    expect(result.byProvider).toEqual([
      { provider: "anthropic", requests: 1, promptTokens: 5, completionTokens: 2, cachedTokens: 0, cost: 0.5 },
      { provider: "openai", requests: 3, promptTokens: 30, completionTokens: 12, cachedTokens: 5, cost: 3 },
      { provider: "unknown", requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 0, cost: 1.5 },
    ]);
    expect(JSON.stringify(result)).not.toContain("safe-id-but-not-a-metric-label");
  });

  it("reports routing retention as a snapshot and excludes skipped/non-terminal attempts", async () => {
    db.run("DELETE FROM routing_events");
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
});
