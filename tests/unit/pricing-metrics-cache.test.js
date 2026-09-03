// P7 (steps 1-2): pricing user-pricing reads share the 5 s cache, and the
// metrics layer memoizes tableExists + the mutation-availability verdict so
// per-request paths stop probing sqlite_master on every call.
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() }));
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: mocks.get,
    all: mocks.all,
    run: mocks.run,
    transaction: (fn) => fn(),
  }),
}));

const { getPricing, getPricingForModel } = await import("../../src/lib/db/repos/pricingRepo.js");
const { runPrometheusMetricMutation, markPrometheusMetricsUnavailable } = await import(
  "../../src/lib/metrics/aggregateState.js"
);
const { isCurrentMetricProvider, BUILT_IN_PROVIDER_IDS } = await import(
  "../../src/lib/metrics/providerRoster.js"
);

const kvAllCalls = () => mocks.all.mock.calls.filter(([sql]) => String(sql).includes("FROM kv")).length;
const masterCalls = (calls) =>
  calls.filter(([sql]) => String(sql).includes("sqlite_master")).length;

describe("pricing + metrics caches", () => {
  it("getPricingForModel shares the cached user-pricing read", async () => {
    mocks.all.mockReset().mockReturnValue([]);
    mocks.get.mockReset().mockReturnValue(null);

    await getPricingForModel("openai", "gpt-4o-mini");
    await getPricingForModel("openai", "gpt-4o-mini");
    await getPricing();
    expect(kvAllCalls()).toBe(1);
  });

  it("isCurrentMetricProvider probes sqlite_master once per table per adapter", async () => {
    const builtin = [...BUILT_IN_PROVIDER_IDS][0];
    const db = {
      get: vi.fn((sql) => (String(sql).includes("sqlite_master") ? { name: "t" } : null)),
      all: vi.fn(() => []),
    };
    // Builtins short-circuit without touching the DB at all.
    expect(isCurrentMetricProvider(db, builtin)).toBe(true);
    expect(db.get).not.toHaveBeenCalled();

    expect(isCurrentMetricProvider(db, "custom-xyz")).toBe(false);
    const firstCalls = db.get.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    expect(masterCalls(db.get.mock.calls)).toBe(2);

    expect(isCurrentMetricProvider(db, "custom-xyz")).toBe(false);
    // Table existence is memoized: the repeat call re-runs only the two row
    // probes (connection rows can appear at runtime) and zero sqlite_master.
    const repeatCalls = db.get.mock.calls.slice(firstCalls);
    expect(masterCalls(repeatCalls)).toBe(0);
    expect(repeatCalls.length).toBe(firstCalls - 2);
  });

  it("runPrometheusMetricMutation caches availability and mark* resets it", async () => {
    const db = {
      get: vi.fn((sql) =>
        String(sql).includes("sqlite_master")
          ? { name: "prometheusMetricState" }
          : { available: 1 },
      ),
      run: vi.fn(),
      transaction: (fn) => fn(),
    };
    const mutation = vi.fn();

    expect(runPrometheusMetricMutation(db, mutation)).toBe(true);
    expect(runPrometheusMetricMutation(db, mutation)).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(masterCalls(db.get.mock.calls)).toBe(1);

    markPrometheusMetricsUnavailable(db);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE prometheusMetricState"),
    );
    const before = db.get.mock.calls.length;
    expect(runPrometheusMetricMutation(db, mutation)).toBe(true);
    expect(db.get.mock.calls.length).toBeGreaterThan(before);
  });
});
