import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  hashApiKey,
  packApiKeyRecord,
  unpackApiKeyRecord,
  timingSafeEqualStr,
} from "@/lib/crypto/secrets.js";

/**
 * H3: store hashed keys (v1:prefix:sha256). Legacy plaintext rows are accepted
 * on validate and upgraded in place. List endpoints never return the full key.
 */
function rowToKey(row, { includeFullKey = false } = {}) {
  if (!row) return null;
  const unpacked = unpackApiKeyRecord(row.key);
  const displayKey = includeFullKey && unpacked.legacy
    ? row.key
    : (unpacked.prefix || "sk-…");
  return {
    id: row.id,
    key: displayKey,
    keyPrefix: unpacked.prefix || displayKey,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map((r) => rowToKey(r));
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const packed = packApiKeyRecord(result.key);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key, // full key returned ONCE to caller
    keyPrefix: unpackApiKeyRecord(packed).prefix,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, packed, apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const merged = { ...current, ...data };
    // Never rewrite stored hash from a redacted list key
    const storedKey = row.key;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [storedKey, merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = rowToKey({ ...row, name: merged.name, machineId: merged.machineId, isActive: merged.isActive ? 1 : 0 });
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (!key || typeof key !== "string") return false;
  const db = await getAdapter();
  const candidateHash = hashApiKey(key);
  const rows = db.all(`SELECT id, key, isActive FROM apiKeys`);
  for (const row of rows) {
    const active = row.isActive === 1 || row.isActive === true;
    if (!active) continue;
    const unpacked = unpackApiKeyRecord(row.key);
    if (!unpacked.legacy && unpacked.hash) {
      if (timingSafeEqualStr(unpacked.hash, candidateHash)) return true;
      continue;
    }
    // Legacy plaintext row — constant-time-ish compare then upgrade
    if (row.key === key) {
      try {
        db.run(`UPDATE apiKeys SET key = ? WHERE id = ?`, [packApiKeyRecord(key), row.id]);
      } catch { /* best-effort migrate */ }
      return true;
    }
  }
  return false;
}
