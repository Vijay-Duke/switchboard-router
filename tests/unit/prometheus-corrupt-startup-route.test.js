import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/mgmt/v1/_lib/http.js", () => ({
  requireManagementAuth: async () => null,
  fail(status, message, code) {
    return new Response(JSON.stringify({ v: 1, error: { message, code } }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
}));

const originalDataDir = process.env.DATA_DIR;
const originalEnabled = process.env.PROMETHEUS_METRICS_ENABLED;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-prometheus-corrupt-"));
  process.env.DATA_DIR = tempDir;
  process.env.PROMETHEUS_METRICS_ENABLED = "true";
  fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });

  const { createNodeSqliteAdapter } = await import("../../src/lib/db/adapters/nodeSqliteAdapter.js");
  const { MIGRATIONS } = await import("../../src/lib/db/migrations/index.js");
  const seed = await createNodeSqliteAdapter(path.join(tempDir, "db", "data.sqlite"));
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
    seed.transaction(() => migration.up(seed));
  }
  seed.run(
    `INSERT INTO _meta(key, value) VALUES('schemaVersion', '8')
     ON CONFLICT(key) DO UPDATE SET value = '8'`,
  );
  seed.run("INSERT INTO usageDaily(dateKey, data) VALUES('2026-08-22', '{malformed')");
  seed.close();

  vi.resetModules();
  const database = await import("../../src/lib/db/index.js");
  await database.initDb();
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  db = await getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalEnabled === undefined) delete process.env.PROMETHEUS_METRICS_ENABLED;
  else process.env.PROMETHEUS_METRICS_ENABLED = originalEnabled;
});

describe("corrupt Prometheus materialization startup", () => {
  it("keeps the app available and returns sanitized metrics_unavailable", async () => {
    expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usageHistory'")).toBeTruthy();
    expect(db.get("SELECT available FROM prometheusMetricState WHERE id = 1").available).toBe(0);

    const route = await import("../../src/app/api/mgmt/v1/metrics/route.js");
    const response = await route.GET(new Request("http://localhost:20128/api/mgmt/v1/metrics"));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      v: 1,
      error: { message: "Prometheus metrics are unavailable", code: "metrics_unavailable" },
    });
    expect(text).not.toContain("malformed");
    expect(text).not.toContain("# HELP");
  });
});
