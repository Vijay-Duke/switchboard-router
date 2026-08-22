import { requireMetricNumber } from "./numeric.js";

const USAGE_INTEGER_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens"];
const ROUTING_TOTAL_FIELDS = ["requests", "errors", "fallbacks"];

function tableExists(db, name) {
  return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
}

export function markPrometheusMetricsUnavailable(db) {
  if (!tableExists(db, "prometheusMetricState")) return;
  db.run(`UPDATE prometheusMetricState SET available = 0 WHERE id = 1`);
}

function metricMutationsAvailable(db) {
  if (!tableExists(db, "prometheusMetricState")) return false;
  const row = db.get(`SELECT available FROM prometheusMetricState WHERE id = 1`);
  try {
    const available = requireMetricNumber(row?.available, "metricState.available", { integer: true });
    if (![0, 1].includes(available)) throw new Error("invalid Prometheus metric state");
    return available === 1;
  } catch {
    markPrometheusMetricsUnavailable(db);
    return false;
  }
}

export function runPrometheusMetricMutation(db, mutation) {
  if (!metricMutationsAvailable(db)) return false;
  try {
    db.transaction(mutation);
    return true;
  } catch {
    markPrometheusMetricsUnavailable(db);
    return false;
  }
}

export function validateUsageMetricRow(row, context = row?.provider || "usage") {
  if (!row || typeof row.provider !== "string" || !row.provider) {
    throw new Error(`invalid Prometheus usage metric: ${context}.provider`);
  }
  for (const field of USAGE_INTEGER_FIELDS) {
    requireMetricNumber(row[field], `${context}.${field}`, { integer: true });
  }
  requireMetricNumber(row.cost, `${context}.cost`);
  return row;
}

export function validateRoutingTotalRow(row, context = row?.source || "routing") {
  if (!row || typeof row.source !== "string" || !row.source) {
    throw new Error(`invalid Prometheus routing metric: ${context}.source`);
  }
  for (const field of ROUTING_TOTAL_FIELDS) {
    requireMetricNumber(row[field], `${context}.${field}`, { integer: true });
  }
  return row;
}

export function validateRoutingRequestRow(row, context = row?.requestKey || "routingRequest") {
  if (!row || typeof row.source !== "string" || !row.source) {
    throw new Error(`invalid Prometheus routing request: ${context}.source`);
  }
  requireMetricNumber(row.terminalId, `${context}.terminalId`, { integer: true });
  const isError = requireMetricNumber(row.isError, `${context}.isError`, { integer: true });
  const fallbackUsed = requireMetricNumber(row.fallbackUsed, `${context}.fallbackUsed`, { integer: true });
  if (![0, 1].includes(isError) || ![0, 1].includes(fallbackUsed)) {
    throw new Error(`invalid Prometheus routing request: ${context}`);
  }
  return row;
}
