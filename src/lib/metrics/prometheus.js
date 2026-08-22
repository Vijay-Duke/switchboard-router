// @ts-check
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getFetchCacheMetricSnapshot } from "@/lib/db/repos/fetchCacheRepo.js";
import { getRoutingMetricSnapshot } from "@/lib/db/repos/routingRepo.js";
import {
  getActiveRequestMetricSnapshot as getActiveRequests,
  getUsageMetricTotals,
} from "@/lib/db/repos/usageRepo.js";

const CONNECTION_STATES = ["ready", "disabled", "cooldown", "error"];
const AUTO_SOURCES = [
  "router",
  "bandit_policy",
  "cached_route",
  "exploration",
  "judge_flag_escalation",
  "fallback_rescue",
];

export function prometheusMetricsEnabled(env = process.env) {
  return env.PROMETHEUS_METRICS_ENABLED === "true";
}

function escapeLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values = {}) {
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function finite(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Prometheus samples must be finite");
  return Object.is(number, -0) ? 0 : number;
}

function family(name, help, type, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) lines.push(`${name}${labels(sample.labels)} ${finite(sample.value)}`);
  return lines;
}

function provider(value) {
  return String(value || "unknown");
}

function connectionState(connection, nowMs) {
  if (connection?.isActive === false) return "disabled";
  const cooling = Object.entries(connection || {}).some(([key, value]) =>
    (key === "rateLimitedUntil" || key.startsWith("modelLock_"))
    && Number.isFinite(new Date(value).getTime())
    && new Date(value).getTime() > nowMs
  );
  if (cooling) return "cooldown";
  if (["error", "invalid", "unavailable"].includes(String(connection?.testStatus || "").toLowerCase())) return "error";
  return "ready";
}

const SNAPSHOT_TTL_MS = 1000;
const DEFAULT_CACHE_KEY = {};
const snapshotStates = new WeakMap();
const defaultDeps = {
  getUsageMetricTotals,
  getRoutingMetricSnapshot,
  getFetchCacheMetricSnapshot,
  getProviderConnections,
  getActiveRequests,
  now: () => new Date(),
};

function snapshotState(key) {
  let state = snapshotStates.get(key);
  if (!state) {
    state = { text: null, expiresAt: 0, inFlight: null };
    snapshotStates.set(key, state);
  }
  return state;
}

async function collectOnce(deps) {
  const now = deps.now();
  const [usage, routing, cache, connections, active] = await Promise.all([
    deps.getUsageMetricTotals(),
    deps.getRoutingMetricSnapshot(),
    deps.getFetchCacheMetricSnapshot(now),
    deps.getProviderConnections(),
    deps.getActiveRequests(),
  ]);

  const providers = new Set();
  const stateCounts = new Map();
  for (const connection of connections || []) {
    const providerId = provider(connection.provider);
    providers.add(providerId);
    const key = `${providerId}\u0000${connectionState(connection, now.getTime())}`;
    stateCounts.set(key, (stateCounts.get(key) || 0) + 1);
  }
  const boundedProvider = (value) => {
    const candidate = provider(value);
    return candidate === "unknown" || providers.has(candidate) ? candidate : "unknown";
  };

  const activeByProvider = new Map();
  for (const request of active.activeRequests || []) {
    const key = boundedProvider(request.provider);
    activeByProvider.set(key, (activeByProvider.get(key) || 0) + finite(request.count));
  }

  const usageFields = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"];
  const usageByProvider = new Map();
  for (const row of usage.byProvider || []) {
    const key = boundedProvider(row.provider);
    const total = usageByProvider.get(key) || {
      provider: key,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    };
    for (const field of usageFields) total[field] += finite(row[field]);
    usageByProvider.set(key, total);
  }
  const usageRows = [...usageByProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const families = [
    family(
      "switchboard_usage_requests_total",
      "Completed usage records accumulated for the gateway.",
      "counter",
      usageRows.map((row) => ({ labels: { provider: row.provider }, value: row.requests })),
    ),
    family(
      "switchboard_usage_tokens_total",
      "Tokens recorded for completed usage; cached is the provider-reported cache-read subset.",
      "counter",
      usageRows.flatMap((row) => [
        { labels: { provider: row.provider, direction: "input" }, value: row.promptTokens },
        { labels: { provider: row.provider, direction: "output" }, value: row.completionTokens },
        { labels: { provider: row.provider, direction: "cached" }, value: row.cachedTokens },
      ]),
    ),
    family(
      "switchboard_usage_cost_usd_total",
      "Calculated US dollar cost accumulated for completed usage records.",
      "counter",
      usageRows.map((row) => ({ labels: { provider: row.provider }, value: row.cost })),
    ),
    family(
      "switchboard_active_requests",
      "Requests currently tracked as active, aggregated by provider.",
      "gauge",
      [...activeByProvider.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([providerId, value]) => ({ labels: { provider: providerId }, value })),
    ),
    family(
      "switchboard_provider_connections",
      "Configured provider connections by current ready, disabled, cooldown, or error state.",
      "gauge",
      [...providers].sort().flatMap((providerId) => CONNECTION_STATES.map((state) => ({
        labels: { provider: providerId, state },
        value: stateCounts.get(`${providerId}\u0000${state}`) || 0,
      }))),
    ),
    family(
      "switchboard_routing_retained_requests",
      "Distinct terminal routing requests in the retained routing event set.",
      "gauge",
      [{ value: routing.retainedRequests }],
    ),
    family(
      "switchboard_routing_retained_errors",
      "Distinct retained terminal routing requests with worker HTTP status at least 400.",
      "gauge",
      [{ value: routing.retainedErrors }],
    ),
    family(
      "switchboard_routing_retained_fallbacks",
      "Distinct retained terminal routing requests that used fallback or rescue.",
      "gauge",
      [{ value: routing.retainedFallbacks }],
    ),
    family(
      "switchboard_auto_retained_decisions",
      "Retained terminal Auto-routing decisions by fixed decision source.",
      "gauge",
      AUTO_SOURCES.map((source) => ({ labels: { source }, value: routing.autoDecisions?.[source] || 0 })),
    ),
    family(
      "switchboard_fetch_cache_entries",
      "Unexpired entries currently stored in the fetch and search cache.",
      "gauge",
      [{ value: cache.entries }],
    ),
    family(
      "switchboard_fetch_cache_bytes",
      "Bytes currently stored by unexpired fetch and search cache entries.",
      "gauge",
      [{ value: cache.bytes }],
    ),
  ];
  return `${families.flat().join("\n")}\n`;
}

export function collectPrometheusMetrics(injected) {
  const cacheKey = injected || DEFAULT_CACHE_KEY;
  const state = snapshotState(cacheKey);
  const currentTime = Date.now();
  if (state.text != null && state.expiresAt > currentTime) return Promise.resolve(state.text);
  if (state.inFlight) return state.inFlight;
  const deps = injected ? { ...defaultDeps, ...injected } : defaultDeps;
  state.inFlight = collectOnce(deps)
    .then((text) => {
      state.text = text;
      state.expiresAt = Date.now() + SNAPSHOT_TTL_MS;
      return text;
    })
    .finally(() => {
      state.inFlight = null;
    });
  return state.inFlight;
}
