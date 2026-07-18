import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { canonicalModelId } from "@/lib/model-probe/canonicalId.js";

const SCOPE = "disabledModels";

export function normalizeDisabledModelIds(providerAlias, ids) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => canonicalModelId(id, providerAlias))
      .filter(Boolean),
  )];
}

export function removeEnabledModelIds(providerAlias, disabledIds, enabledIds) {
  const removeSet = new Set(normalizeDisabledModelIds(providerAlias, enabledIds));
  return normalizeDisabledModelIds(providerAlias, disabledIds)
    .filter((id) => !removeSet.has(id));
}

export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  return row ? (parseJson(row.value, []) || []) : [];
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const merged = normalizeDisabledModelIds(providerAlias, [...current, ...ids]);
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson(merged)]
    );
  });
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  db.transaction(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const next = removeEnabledModelIds(providerAlias, current, ids);
    if (next.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, providerAlias, stringifyJson(next)]
      );
    }
  });
}
