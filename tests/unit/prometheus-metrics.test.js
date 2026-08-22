import { describe, expect, it } from "vitest";
import {
  collectPrometheusMetrics,
  prometheusMetricsEnabled,
} from "../../src/lib/metrics/prometheus.js";

function deps(overrides = {}) {
  return {
    getUsageMetricTotals: async () => ({ byProvider: [
      { provider: "openai", requests: 4, promptTokens: 40, completionTokens: 10, cachedTokens: 5, cost: 0.125 },
      { provider: "quoted\"provider\\line\nnext", requests: 1, promptTokens: 2, completionTokens: 3, cachedTokens: 0, cost: 0 },
    ] }),
    getRoutingMetricSnapshot: async () => ({
      retainedRequests: 3, retainedErrors: 1, retainedFallbacks: 1,
      autoDecisions: { router: 1, bandit_policy: 0, cached_route: 0, exploration: 1, judge_flag_escalation: 0, fallback_rescue: 1 },
    }),
    getFetchCacheMetricSnapshot: async () => ({ entries: 2, bytes: 2048 }),
    getProviderConnections: async () => [
      { id: "DO-NOT-EXPORT-ID", provider: "openai", name: "DO-NOT-EXPORT-NAME", email: "secret@example.com", isActive: true, testStatus: "ok" },
      { id: "cool", provider: "openai", isActive: true, testStatus: "unavailable", modelLock_gpt: "2026-08-22T13:00:00.000Z" },
      { id: "bad", provider: "anthropic", isActive: true, testStatus: "error", lastError: "DO-NOT-EXPORT-ERROR" },
      { id: "off", provider: "anthropic", isActive: false, testStatus: "error" },
      { id: "quoted", provider: "quoted\"provider\\line\nnext", isActive: true, testStatus: "ok" },
    ],
    getProviderNodes: async () => [],
    getActiveRequests: async () => ({ activeRequests: [
      { provider: "openai", model: "DO-NOT-EXPORT-MODEL", account: "DO-NOT-EXPORT-ACCOUNT", count: 2 },
      { provider: "openai", model: "another-secret-model", account: "another-secret-account", count: 1 },
    ] }),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    ...overrides,
  };
}

describe("Prometheus collector", () => {
  it("is fail-closed and opt-in only for exact true", () => {
    expect(prometheusMetricsEnabled({})).toBe(false);
    expect(prometheusMetricsEnabled({ PROMETHEUS_METRICS_ENABLED: "TRUE" })).toBe(false);
    expect(prometheusMetricsEnabled({ PROMETHEUS_METRICS_ENABLED: "1" })).toBe(false);
    expect(prometheusMetricsEnabled({ PROMETHEUS_METRICS_ENABLED: "true" })).toBe(true);
  });

  it("emits the fixed families in deterministic order with honest types and help", async () => {
    const text = await collectPrometheusMetrics(deps());
    const headers = text.split("\n").filter((line) => line.startsWith("#"));
    expect(headers).toEqual([
      "# HELP switchboard_usage_requests_total Completed usage records accumulated for the gateway.",
      "# TYPE switchboard_usage_requests_total counter",
      "# HELP switchboard_usage_tokens_total Tokens recorded for completed usage; cached is the provider-reported cache-read subset.",
      "# TYPE switchboard_usage_tokens_total counter",
      "# HELP switchboard_usage_cost_usd_total Calculated US dollar cost accumulated for completed usage records.",
      "# TYPE switchboard_usage_cost_usd_total counter",
      "# HELP switchboard_active_requests Requests currently tracked as active, aggregated by provider.",
      "# TYPE switchboard_active_requests gauge",
      "# HELP switchboard_provider_connections Configured provider connections by current ready, disabled, cooldown, or error state.",
      "# TYPE switchboard_provider_connections gauge",
      "# HELP switchboard_routing_retained_requests Distinct terminal routing requests in the retained routing event set.",
      "# TYPE switchboard_routing_retained_requests gauge",
      "# HELP switchboard_routing_retained_errors Distinct retained terminal routing requests with worker HTTP status at least 400.",
      "# TYPE switchboard_routing_retained_errors gauge",
      "# HELP switchboard_routing_retained_fallbacks Distinct retained terminal routing requests that used fallback or rescue.",
      "# TYPE switchboard_routing_retained_fallbacks gauge",
      "# HELP switchboard_auto_retained_decisions Retained terminal Auto-routing decisions by fixed decision source.",
      "# TYPE switchboard_auto_retained_decisions gauge",
      "# HELP switchboard_fetch_cache_entries Unexpired entries currently stored in the fetch and search cache.",
      "# TYPE switchboard_fetch_cache_entries gauge",
      "# HELP switchboard_fetch_cache_bytes Bytes currently stored by unexpired fetch and search cache entries.",
      "# TYPE switchboard_fetch_cache_bytes gauge",
    ]);
    expect(text).not.toMatch(/routing_.*_total/);
    expect(text).not.toMatch(/auto_.*_total/);
    expect(text).not.toContain("histogram");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("aggregates live state and emits all fixed zero-valued states and sources", async () => {
    const text = await collectPrometheusMetrics(deps());
    expect(text).toContain('switchboard_active_requests{provider="openai"} 3');
    expect(text).toContain('switchboard_provider_connections{provider="openai",state="ready"} 1');
    expect(text).toContain('switchboard_provider_connections{provider="openai",state="cooldown"} 1');
    expect(text).toContain('switchboard_provider_connections{provider="anthropic",state="error"} 1');
    expect(text).toContain('switchboard_provider_connections{provider="anthropic",state="disabled"} 1');
    expect(text).toContain('switchboard_provider_connections{provider="openai",state="disabled"} 0');
    expect(text).toContain('switchboard_auto_retained_decisions{source="bandit_policy"} 0');
    expect(text).toContain("switchboard_fetch_cache_entries 2");
    expect(text).toContain("switchboard_fetch_cache_bytes 2048");
  });

  it("escapes labels and never emits sensitive or high-cardinality fields", async () => {
    const text = await collectPrometheusMetrics(deps());
    expect(text).toContain('provider="quoted\\\"provider\\\\line\\nnext"');
    for (const forbidden of [
      "DO-NOT-EXPORT-ID", "DO-NOT-EXPORT-NAME", "secret@example.com",
      "DO-NOT-EXPORT-ERROR", "DO-NOT-EXPORT-MODEL", "DO-NOT-EXPORT-ACCOUNT",
      "client_key_id", "connection_id", "model=", "combo=", "endpoint=",
    ]) expect(text).not.toContain(forbidden);
  });

  it("collapses providers outside the current configured roster into unknown", async () => {
    const text = await collectPrometheusMetrics(deps({
      getUsageMetricTotals: async () => ({ byProvider: [
        { provider: "openai", requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 1, cost: 1 },
        { provider: "retired-a", requests: 3, promptTokens: 30, completionTokens: 12, cachedTokens: 2, cost: 2 },
        { provider: "retired-b", requests: 4, promptTokens: 40, completionTokens: 16, cachedTokens: 3, cost: 3 },
      ] }),
      getProviderConnections: async () => [
        { id: "current", provider: "openai", isActive: true, testStatus: "ok" },
      ],
      getActiveRequests: async () => ({ activeRequests: [
        { provider: "openai", count: 1 },
        { provider: "retired-a", count: 2 },
        { provider: "retired-b", count: 3 },
      ] }),
    }));

    expect(text).toContain('switchboard_usage_requests_total{provider="openai"} 2');
    expect(text).toContain('switchboard_usage_requests_total{provider="unknown"} 7');
    expect(text).toContain('switchboard_active_requests{provider="unknown"} 5');
    expect(text).not.toContain("retired-a");
    expect(text).not.toContain("retired-b");
  });


  it("keeps fixed native and current provider-node IDs without connections", async () => {
    const text = await collectPrometheusMetrics(deps({
      getUsageMetricTotals: async () => ({ byProvider: [
        { provider: "anthropic", requests: 2, promptTokens: 20, completionTokens: 8, cachedTokens: 1, cost: 1 },
        { provider: "custom-node", requests: 3, promptTokens: 30, completionTokens: 12, cachedTokens: 2, cost: 2 },
        { provider: "deleted-custom", requests: 4, promptTokens: 40, completionTokens: 16, cachedTokens: 3, cost: 3 },
      ] }),
      getProviderConnections: async () => [],
      getProviderNodes: async () => [{ id: "custom-node" }],
      getActiveRequests: async () => ({ activeRequests: [
        { provider: "anthropic", count: 1 },
        { provider: "custom-node", count: 2 },
        { provider: "deleted-custom", count: 3 },
      ] }),
    }));

    expect(text).toContain('switchboard_usage_requests_total{provider="anthropic"} 2');
    expect(text).toContain('switchboard_usage_requests_total{provider="custom-node"} 3');
    expect(text).toContain('switchboard_usage_requests_total{provider="unknown"} 4');
    expect(text).toContain('switchboard_active_requests{provider="anthropic"} 1');
    expect(text).toContain('switchboard_active_requests{provider="custom-node"} 2');
    expect(text).toContain('switchboard_active_requests{provider="unknown"} 3');
    expect(text).not.toContain("deleted-custom");
  });
  it("coalesces concurrent collection and reuses a short-lived snapshot", async () => {
    let reads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const shared = deps({
      getUsageMetricTotals: async () => {
        reads += 1;
        await gate;
        return { byProvider: [] };
      },
    });

    const first = collectPrometheusMetrics(shared);
    const second = collectPrometheusMetrics(shared);
    expect(reads).toBe(1);
    release();
    const [firstText, secondText] = await Promise.all([first, second]);
    expect(secondText).toBe(firstText);
    expect(await collectPrometheusMetrics(shared)).toBe(firstText);
    expect(reads).toBe(1);
  });

  it("rejects the whole collection when any source fails", async () => {
    await expect(collectPrometheusMetrics(deps({
      getRoutingMetricSnapshot: async () => { throw new Error("db unavailable"); },
    }))).rejects.toThrow("db unavailable");
  });

  it("rejects non-finite samples instead of emitting invalid text", async () => {
    await expect(collectPrometheusMetrics(deps({
      getFetchCacheMetricSnapshot: async () => ({ entries: Number.NaN, bytes: 2048 }),
    }))).rejects.toThrow("invalid Prometheus metric number");
  });
});
