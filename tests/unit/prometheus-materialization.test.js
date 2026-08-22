import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import materialization from "../../src/lib/db/migrations/009-prometheus-materialization.js";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let usageRepo;
let routingRepo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-prometheus-materialized-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const database = await import("../../src/lib/db/index.js");
  await database.initDb();
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  db = await getAdapter();
  usageRepo = await import("../../src/lib/db/repos/usageRepo.js");
  routingRepo = await import("../../src/lib/db/repos/routingRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function seedConnection(provider) {
  const now = "2026-08-22T00:00:00.000Z";
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, 'apikey', 1, '{}', ?, ?)`,
    [`connection-${provider}`, provider, now, now],
  );
}

describe("Prometheus materialization migration", () => {
  it("backfills compact usage and routing snapshots without sensitive dimensions", async () => {
    db.run("DELETE FROM providerConnections");
    db.run("DELETE FROM usageDaily");
    db.run("DELETE FROM routing_events");
    seedConnection("openai");
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      "2026-08-22",
      JSON.stringify({
        requests: 3,
        promptTokens: 30,
        completionTokens: 12,
        cachedTokens: 4,
        cost: 1.5,
        byProvider: {
          openai: { requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 4, cost: 1 },
          "retired-secret-provider": { requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 0, cost: 0.5 },
        },
        byModel: { "DO-NOT-MATERIALIZE-MODEL": { requests: 3 } },
        byClientKey: { "DO-NOT-MATERIALIZE-KEY": { requests: 3 } },
      }),
    ]);
    await routingRepo.insertRoutingEvent({
      comboName: "DO-NOT-MATERIALIZE-COMBO",
      requestId: "request-1",
      pickedWorker: "DO-NOT-MATERIALIZE-MODEL",
      routerReason: "router",
      workerStatus: 200,
      meta: { terminal: true },
    });
    await routingRepo.insertRoutingEvent({
      comboName: "DO-NOT-MATERIALIZE-COMBO",
      requestId: "request-2",
      pickedWorker: "DO-NOT-MATERIALIZE-MODEL",
      routerReason: "retry",
      workerStatus: 502,
      fallbackUsed: true,
      meta: { terminal: true },
    });

    materialization.up(db);

    expect(await usageRepo.getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "openai", requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 4, cost: 1 },
        { provider: "unknown", requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 0, cost: 0.5 },
      ],
    });
    expect(await routingRepo.getRoutingMetricSnapshot()).toEqual({
      retainedRequests: 2,
      retainedErrors: 1,
      retainedFallbacks: 1,
      autoDecisions: {
        router: 1,
        bandit_policy: 0,
        cached_route: 0,
        exploration: 0,
        judge_flag_escalation: 0,
        fallback_rescue: 1,
      },
    });

    const stored = JSON.stringify([
      ...db.all("SELECT * FROM prometheusUsageTotals"),
      ...db.all("SELECT * FROM prometheusRoutingTotals"),
    ]);
    for (const forbidden of [
      "DO-NOT-MATERIALIZE-MODEL",
      "DO-NOT-MATERIALIZE-KEY",
      "DO-NOT-MATERIALIZE-COMBO",
      "request-1",
      "request-2",
      "retired-secret-provider",
    ]) expect(stored).not.toContain(forbidden);
  });

  it("marks metrics unavailable for non-numeric legacy aggregates and can rebuild after repair", () => {
    db.run("DELETE FROM usageDaily");
    db.run("DELETE FROM routing_events");
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      "2026-08-22",
      JSON.stringify({
        requests: " ",
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
      }),
    ]);

    expect(() => materialization.up(db)).not.toThrow();
    expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);

    db.run("UPDATE usageDaily SET data = ? WHERE dateKey = '2026-08-22'", [
      JSON.stringify({
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
      }),
    ]);
    materialization.up(db);
    expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(1);
  });

  it("rolls back materialized tables without changing source data", () => {
    const usageRows = db.get("SELECT COUNT(*) AS count FROM usageDaily").count;
    const routingRows = db.get("SELECT COUNT(*) AS count FROM routing_events").count;

    materialization.down(db);

    expect(db.get("SELECT COUNT(*) AS count FROM usageDaily").count).toBe(usageRows);
    expect(db.get("SELECT COUNT(*) AS count FROM routing_events").count).toBe(routingRows);
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='prometheusUsageTotals'")).toBeUndefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='prometheusRoutingTotals'")).toBeUndefined();

    materialization.up(db);
  });
});
