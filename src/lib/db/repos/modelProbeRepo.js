// @ts-check
import { getAdapter } from "../driver.js";

function rowToProbe(row) {
  if (!row) return null;
  return {
    providerId: row.provider_id,
    scopeKey: row.scope_key,
    modelId: row.model_id,
    kind: row.kind || "llm",
    status: row.status,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    failureClass: row.failure_class || null,
    failureMessage: row.failure_message || null,
    checkedAt: row.checked_at,
  };
}

/**
 * @param {{ providerId: string, scopeKey: string, modelId: string, kind?: string, status: "ok"|"dead"|"retryable", latencyMs?: number|null, failureClass?: string|null, failureMessage?: string|null, checkedAt?: string }} result
 */
export async function upsertProbeResult(result) {
  const providerId = String(result?.providerId || "").trim();
  const scopeKey = String(result?.scopeKey || "").trim();
  const modelId = String(result?.modelId || "").trim();
  const kind = String(result?.kind || "llm").trim() || "llm";
  const status = String(result?.status || "").trim();
  if (!providerId || !scopeKey || !modelId || !["ok", "dead", "retryable"].includes(status)) {
    throw new Error("Invalid probe result");
  }

  const db = await getAdapter();
  const checkedAt = result.checkedAt || new Date().toISOString();
  const latencyMs = Number.isFinite(result.latencyMs) ? Math.max(0, Math.round(Number(result.latencyMs))) : null;
  db.run(
    `INSERT INTO provider_model_probe(
       provider_id, scope_key, model_id, kind, status, latency_ms,
       failure_class, failure_message, checked_at
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, scope_key, kind, model_id) DO UPDATE SET
       status = excluded.status,
       latency_ms = excluded.latency_ms,
       failure_class = excluded.failure_class,
       failure_message = excluded.failure_message,
       checked_at = excluded.checked_at`,
    [
      providerId,
      scopeKey,
      modelId,
      kind,
      status,
      latencyMs,
      result.failureClass || null,
      result.failureMessage ? String(result.failureMessage).slice(0, 500) : null,
      checkedAt,
    ],
  );
  return { providerId, scopeKey, modelId, kind, status, latencyMs, failureClass: result.failureClass || null, failureMessage: result.failureMessage || null, checkedAt };
}

export async function getProbesForScope(providerId, scopeKey) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM provider_model_probe WHERE provider_id = ? AND scope_key = ? ORDER BY checked_at DESC`,
    [providerId, scopeKey],
  );
  return rows.map(rowToProbe).filter(Boolean);
}

export async function getDeadModelIds(providerId, scopeKey, kind = null) {
  const db = await getAdapter();
  const params = [providerId, scopeKey];
  let sql = `SELECT model_id FROM provider_model_probe WHERE provider_id = ? AND scope_key = ? AND status = 'dead'`;
  if (kind) {
    sql += ` AND kind = ?`;
    params.push(kind);
  }
  return db.all(sql, params).map((row) => row.model_id);
}

export async function clearProbes(providerId, scopeKey) {
  const db = await getAdapter();
  const result = db.run(`DELETE FROM provider_model_probe WHERE provider_id = ? AND scope_key = ?`, [providerId, scopeKey]);
  return result?.changes || 0;
}

export async function clearProbesForProvider(providerId) {
  const db = await getAdapter();
  const result = db.run(`DELETE FROM provider_model_probe WHERE provider_id = ?`, [providerId]);
  return result?.changes || 0;
}

/**
 * @param {{ providerId: string, scopeKey: string, modelIds: string[], kind?: string }} options
 */
export async function deleteProbeRows({ providerId, scopeKey, modelIds, kind = "llm" }) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) return 0;
  const db = await getAdapter();
  let deleted = 0;
  db.transaction(() => {
    for (const modelId of modelIds) {
      const result = db.run(
        `DELETE FROM provider_model_probe WHERE provider_id = ? AND scope_key = ? AND kind = ? AND model_id = ?`,
        [providerId, scopeKey, kind || "llm", modelId],
      );
      deleted += result?.changes || 0;
    }
  });
  return deleted;
}
