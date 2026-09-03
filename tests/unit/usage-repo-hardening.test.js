import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

const mocks = vi.hoisted(() => ({ adapter: { all: vi.fn(), get: vi.fn(), run: vi.fn() } }));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => mocks.adapter }));
vi.mock("../../src/lib/db/helpers/metaStore.js", () => ({
  getMeta: vi.fn(async () => null),
  setMeta: vi.fn(async () => {}),
}));

const { getUsageStats, getUsageHistory } = await import("../../src/lib/db/repos/usageRepo.js");

const row = (over = {}) => ({
  timestamp: new Date().toISOString(),
  provider: "",
  model: "gpt-4",
  connectionId: null,
  apiKey: null,
  endpoint: "/v1/chat/completions",
  promptTokens: 1,
  completionTokens: 1,
  cost: 0,
  tokens: "{}",
  status: "ok",
  ...over,
});

describe("usageRepo hardening", () => {
  beforeEach(() => {
    mocks.adapter.all.mockReset();
    mocks.adapter.get.mockReset().mockReturnValue(null);
    mocks.adapter.run.mockReset();
  });
  afterEach(() => {
    delete Object.prototype.requests;
    delete Object.prototype.cost;
  });

  /**
   * Regression: stats accumulators were plain `{}`, so a row whose model is
   * "__proto__" resolved `stats.byModel["__proto__"]` to Object.prototype,
   * skipped the initializer, and incremented counters onto the prototype.
   */
  it("does not pollute Object.prototype from a '__proto__' model name", async () => {
    mocks.adapter.all.mockReturnValue([row({ model: "__proto__", provider: "" })]);

    const stats = await getUsageStats("24h");

    expect(Object.prototype.requests).toBeUndefined();
    expect({}.requests).toBeUndefined();
    expect(stats.byModel["__proto__"]).toMatchObject({ requests: 1 });
  });

  /**
   * Regression: `new Date(filter.startDate).toISOString()` threw a RangeError
   * on an unparseable query param, turning a bad request into a 500.
   */
  it("ignores an unparseable startDate instead of throwing", async () => {
    mocks.adapter.all.mockReturnValue([]);

    await expect(getUsageHistory({ startDate: "not-a-date" })).resolves.toEqual([]);

    const [sql, params] = mocks.adapter.all.mock.calls[0];
    expect(sql).not.toContain("timestamp >=");
    expect(params).toEqual([]);
  });

  it("still applies a valid startDate", async () => {
    mocks.adapter.all.mockReturnValue([]);

    await getUsageHistory({ startDate: "2024-01-01T00:00:00.000Z" });

    const [sql, params] = mocks.adapter.all.mock.calls[0];
    expect(sql).toContain("timestamp >=");
    expect(params).toEqual(["2024-01-01T00:00:00.000Z"]);
  });
});

// P4/P5/P7 hot-path coverage against a real database. This file top-level
// mocks the db driver, so this block opts back out (doUnmock + fresh module
// instances) into a temp-dir database. It runs LAST in this file and restores
// DATA_DIR afterwards, so the mocked suites above are unaffected.
describe("usage hot-path against a real database", () => {
  const prevDataDir = process.env.DATA_DIR;
  let tempDir;
  let realDb;
  let adapter;
  let allSql;
  let getSql;
  let runSql;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-usage-hotpath-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doUnmock("../../src/lib/db/driver.js");
    realDb = await import("../../src/lib/db/repos/usageRepo.js");
    const driver = await import("../../src/lib/db/driver.js");
    const idx = await import("../../src/lib/db/index.js");
    await idx.initDb();
    adapter = await driver.getAdapter();
    allSql = [];
    getSql = [];
    runSql = [];
    const origAll = adapter.all.bind(adapter);
    const origGet = adapter.get.bind(adapter);
    const origRun = adapter.run.bind(adapter);
    vi.spyOn(adapter, "all").mockImplementation((sql, params) => {
      allSql.push(String(sql));
      return origAll(sql, params);
    });
    vi.spyOn(adapter, "get").mockImplementation((sql, params) => {
      getSql.push(String(sql));
      return origGet(sql, params);
    });
    vi.spyOn(adapter, "run").mockImplementation((sql, params) => {
      runSql.push(String(sql));
      return origRun(sql, params);
    });
  }, 120000);

  afterAll(() => {
    adapter?.all?.mockRestore?.();
    adapter?.get?.mockRestore?.();
    adapter?.run?.mockRestore?.();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
  });

  const resetSql = () => {
    allSql.length = 0;
    getSql.length = 0;
    runSql.length = 0;
  };

  const entry = (over = {}) => ({
    model: "hot-model",
    tokens: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 },
    endpoint: "/v1/chat",
    status: "ok",
    ...over,
  });

  it("P4: getProviderRequestCounts sums daily blobs in one query, no history/connection reads", async () => {
    await realDb.saveRequestUsage(entry({ provider: "cnt-a", requestId: "cnt-a-1" }));
    await realDb.saveRequestUsage(entry({ provider: "cnt-a", requestId: "cnt-a-2" }));
    await realDb.saveRequestUsage(entry({ provider: "cnt-b", requestId: "cnt-b-1" }));

    resetSql();
    const counts = await realDb.getProviderRequestCounts(7);

    expect(counts["cnt-a"]).toBe(2);
    expect(counts["cnt-b"]).toBe(1);
    expect(allSql).toHaveLength(1);
    expect(allSql[0]).toContain("usageDaily");
    expect(allSql.some((s) => s.includes("usageHistory"))).toBe(false);
    expect(allSql.some((s) => s.includes("providerConnections") || s.includes("apiKeys"))).toBe(false);
  });

  it("P5: 7d lastUsed equals the max timestamp via one GROUP BY overlay", async () => {
    const t1 = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const t2 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const t3 = new Date(Date.now() - 3600 * 1000).toISOString();
    await realDb.saveRequestUsage(entry({ provider: "lu-prov", model: "lu-model", timestamp: t1, requestId: "lu-1" }));
    await realDb.saveRequestUsage(entry({ provider: "lu-prov", model: "lu-model", timestamp: t2, requestId: "lu-2" }));
    await realDb.saveRequestUsage(entry({ provider: "lu-prov", model: "lu-model", timestamp: t3, requestId: "lu-3" }));

    resetSql();
    const stats = await realDb.getUsageStats("7d");

    // The daily blob seeds lastUsed at day precision; the overlay must refine
    // it to the max full timestamp (or the local day key when TZ pushes the
    // local date past the UTC instant — same lexical-max rule as the code).
    const d = new Date(t3);
    const localKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(stats.byModel["lu-model (lu-prov)"].lastUsed).toBe([t3, localKey].sort().pop());

    const overlay = allSql.filter((s) => s.includes("FROM usageHistory") && s.includes("GROUP BY"));
    expect(overlay).toHaveLength(1);
    expect(overlay[0]).toMatch(/MAX\(timestamp\)/);
    // No unbounded full-table pull: every history read is aggregated, capped,
    // or windowed.
    for (const s of allSql.filter((st) => st.includes("FROM usageHistory"))) {
      expect(s).toMatch(/LIMIT|GROUP BY|timestamp <=/);
    }
  });

  it("P5: 24h totals come from denormalized columns even with tokens JSON NULL", async () => {
    await realDb.saveRequestUsage(entry({ provider: "tk-prov", model: "tk-model", tokens: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 }, requestId: "tk-1" }));
    await realDb.saveRequestUsage(entry({ provider: "tk-prov", model: "tk-model", tokens: { prompt_tokens: 20, completion_tokens: 7, cached_tokens: 4 }, requestId: "tk-2" }));
    await realDb.saveRequestUsage(entry({ provider: "tk-prov", model: "tk-model", tokens: { prompt_tokens: 30, completion_tokens: 9, cached_tokens: 5 }, requestId: "tk-3" }));
    adapter.run(`UPDATE usageHistory SET tokens = NULL WHERE requestId IN ('tk-1', 'tk-2', 'tk-3')`);

    resetSql();
    const stats = await realDb.getUsageStats("24h");

    expect(stats.byProvider["tk-prov"]).toMatchObject({
      requests: 3, promptTokens: 60, completionTokens: 21, cachedTokens: 12,
    });
    expect(stats.byModel["tk-model (tk-prov)"]).toMatchObject({
      requests: 3, promptTokens: 60, completionTokens: 21, cachedTokens: 12,
    });

    const agg24 = allSql.filter((s) => s.includes("FROM usageHistory") && s.includes("cachedTokens") && !s.includes("GROUP BY"));
    expect(agg24).toHaveLength(1);
    const cols = agg24[0].split(/select/i)[1].split(/from/i)[0].split(",").map((c) => c.trim());
    expect(cols).toContain("cachedTokens");
    expect(cols).not.toContain("tokens");
  });

  it("P7 step 3: usage counters increment via atomic relative updates", async () => {
    const metaVal = (key) => {
      const row = adapter.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
      return row ? parseInt(row.value, 10) : 0;
    };
    const beforeTotal = metaVal("totalRequestsLifetime");
    const beforeHist = metaVal("usageHistoryCount");

    resetSql();
    await realDb.saveRequestUsage(entry({ provider: "p7-prov", requestId: "p7-1" }));
    await realDb.saveRequestUsage(entry({ provider: "p7-prov", requestId: "p7-2" }));
    // A replayed requestId is a silent no-op and must not move the counters.
    await realDb.saveRequestUsage(entry({ provider: "p7-prov", requestId: "p7-2" }));

    expect(metaVal("totalRequestsLifetime")).toBe(beforeTotal + 2);
    expect(metaVal("usageHistoryCount")).toBe(beforeHist + 2);

    // Steady state: no SELECT-then-write-absolute pair, no COUNT(*) scan.
    expect(getSql.some((s) => s.includes("totalRequestsLifetime"))).toBe(false);
    expect(getSql.some((s) => s.includes("COUNT(*)"))).toBe(false);
    expect(runSql.some((s) => s.includes("totalRequestsLifetime") && s.includes("CAST(_meta.value AS INTEGER) + 1"))).toBe(true);
    expect(runSql.some((s) => s.includes("usageHistoryCount") && s.includes("CAST(value AS INTEGER) + 1"))).toBe(true);
  });

  it("P7 step 3: a pre-counter DB bootstraps usageHistoryCount from an exact COUNT(*) once", async () => {
    adapter.run(`DELETE FROM _meta WHERE key = 'usageHistoryCount'`);
    const rowsBefore = adapter.get(`SELECT COUNT(*) AS c FROM usageHistory`).c;
    expect(rowsBefore).toBeGreaterThan(1);

    resetSql();
    await realDb.saveRequestUsage(entry({ provider: "p7-prov", requestId: "p7-boot-1" }));
    expect(parseInt(adapter.get(`SELECT value FROM _meta WHERE key = 'usageHistoryCount'`).value, 10)).toBe(rowsBefore + 1);
    expect(getSql.filter((s) => s.includes("COUNT(*)"))).toHaveLength(1);

    resetSql();
    await realDb.saveRequestUsage(entry({ provider: "p7-prov", requestId: "p7-boot-2" }));
    expect(parseInt(adapter.get(`SELECT value FROM _meta WHERE key = 'usageHistoryCount'`).value, 10)).toBe(rowsBefore + 2);
    expect(getSql.some((s) => s.includes("COUNT(*)"))).toBe(false);
  });
});
