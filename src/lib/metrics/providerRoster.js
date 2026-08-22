import REGISTRY from "open-sse/providers/registry/index.js";

export const BUILT_IN_PROVIDER_IDS = new Set(
  REGISTRY.map((entry) => entry?.id).filter((id) => typeof id === "string" && id),
);

function tableExists(db, name) {
  return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
}

export function currentMetricProviderIds(db) {
  const providers = new Set(BUILT_IN_PROVIDER_IDS);
  if (tableExists(db, "providerConnections")) {
    for (const row of db.all(`SELECT DISTINCT provider FROM providerConnections`) || []) {
      if (typeof row.provider === "string" && row.provider) providers.add(row.provider);
    }
  }
  if (tableExists(db, "providerNodes")) {
    for (const row of db.all(`SELECT id FROM providerNodes`) || []) {
      if (typeof row.id === "string" && row.id) providers.add(row.id);
    }
  }
  return providers;
}

export function isCurrentMetricProvider(db, provider) {
  if (typeof provider !== "string" || !provider) return false;
  if (BUILT_IN_PROVIDER_IDS.has(provider)) return true;
  if (tableExists(db, "providerConnections")
    && db.get(`SELECT 1 AS configured FROM providerConnections WHERE provider = ? LIMIT 1`, [provider])) {
    return true;
  }
  return Boolean(
    tableExists(db, "providerNodes")
    && db.get(`SELECT 1 AS configured FROM providerNodes WHERE id = ? LIMIT 1`, [provider]),
  );
}

export function retirePrometheusProviderInTx(db, provider) {
  if (!provider || provider === "unknown" || isCurrentMetricProvider(db, provider)) return;
  if (!tableExists(db, "prometheusUsageTotals")) return;
  const row = db.get(
    `SELECT requests, promptTokens, completionTokens, cachedTokens, cost
     FROM prometheusUsageTotals WHERE provider = ?`,
    [provider],
  );
  if (!row) return;
  db.run(
    `INSERT INTO prometheusUsageTotals(provider, requests, promptTokens, completionTokens, cachedTokens, cost)
     VALUES('unknown', ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       requests = requests + excluded.requests,
       promptTokens = promptTokens + excluded.promptTokens,
       completionTokens = completionTokens + excluded.completionTokens,
       cachedTokens = cachedTokens + excluded.cachedTokens,
       cost = cost + excluded.cost`,
    [row.requests, row.promptTokens, row.completionTokens, row.cachedTokens, row.cost],
  );
  db.run(`DELETE FROM prometheusUsageTotals WHERE provider = ?`, [provider]);
}
