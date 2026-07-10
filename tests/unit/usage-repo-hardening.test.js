import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
