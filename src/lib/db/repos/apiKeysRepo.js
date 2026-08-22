import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  apiKeyLookupId,
  apiKeyPrefix,
  matchesApiKeyRecord,
  matchesApiKeyRecordAsync,
  packApiKeyRecord,
  unpackApiKeyRecord,
} from "@/lib/crypto/secrets.js";

export const CLIENT_KEY_POLICY_BOUNDS = Object.freeze({
  maxAllowlistEntries: 100,
  maxTargetLength: 256,
  maxRatePerMinute: 60_000,
  maxConcurrency: 1_000,
  maxSpendUsd: 1_000_000,
});

const PATCH_FIELDS = new Set([
  "name",
  "isActive",
  "allowedModels",
  "allowedCombos",
  "expiresAt",
  "rateLimitPerMinute",
  "concurrencyLimit",
  "spendLimitUsd",
]);

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToKey(row) {
  if (!row) return null;
  const unpacked = unpackApiKeyRecord(row.key);
  return {
    id: row.id,
    keyPrefix: unpacked.prefix || "sk-…",
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    allowedModels: parseArray(row.allowedModels),
    allowedCombos: parseArray(row.allowedCombos),
    expiresAt: row.expiresAt || null,
    rateLimitPerMinute: row.rateLimitPerMinute == null ? null : Number(row.rateLimitPerMinute),
    concurrencyLimit: row.concurrencyLimit == null ? null : Number(row.concurrencyLimit),
    spendLimitUsd: row.spendLimitUsd == null ? null : Number(row.spendLimitUsd),
    spentUsd: Number(row.spentUsd || 0),
  };
}

function normalizeAllowlist(name, value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > CLIENT_KEY_POLICY_BOUNDS.maxAllowlistEntries) {
    throw new Error(`${name} must contain at most ${CLIENT_KEY_POLICY_BOUNDS.maxAllowlistEntries} entries`);
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error(`${name} entries must be strings`);
    const target = raw.trim();
    if (!target) throw new Error(`${name} entries must not be empty`);
    if (target.length > CLIENT_KEY_POLICY_BOUNDS.maxTargetLength) {
      throw new Error(`${name} entry length exceeds ${CLIENT_KEY_POLICY_BOUNDS.maxTargetLength}`);
    }
    if (!seen.has(target)) {
      seen.add(target);
      normalized.push(target);
    }
  }
  return normalized;
}

function normalizeInteger(name, value, max) {
  if (value == null || value === "") return null;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}`);
  }
  return value;
}

export function normalizeClientKeyPatch(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("client key patch must be an object");
  }
  for (const key of Object.keys(data)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`unknown client key field: ${key}`);
  }

  const out = {};
  if (Object.hasOwn(data, "name")) {
    if (typeof data.name !== "string") throw new Error("name must be a string");
    out.name = data.name;
  }
  if (Object.hasOwn(data, "isActive")) {
    if (typeof data.isActive !== "boolean") throw new Error("isActive must be a boolean");
    out.isActive = data.isActive;
  }
  if (Object.hasOwn(data, "allowedModels")) out.allowedModels = normalizeAllowlist("allowedModels", data.allowedModels);
  if (Object.hasOwn(data, "allowedCombos")) out.allowedCombos = normalizeAllowlist("allowedCombos", data.allowedCombos);
  if (Object.hasOwn(data, "expiresAt")) {
    if (data.expiresAt == null || data.expiresAt === "") {
      out.expiresAt = null;
    } else {
      if (typeof data.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.expiresAt)) {
        throw new Error("expiresAt must be a valid ISO instant");
      }
      const instant = new Date(data.expiresAt);
      if (Number.isNaN(instant.getTime())) throw new Error("expiresAt must be a valid ISO instant");
      out.expiresAt = instant.toISOString();
    }
  }
  if (Object.hasOwn(data, "rateLimitPerMinute")) {
    out.rateLimitPerMinute = normalizeInteger("rateLimitPerMinute", data.rateLimitPerMinute, CLIENT_KEY_POLICY_BOUNDS.maxRatePerMinute);
  }
  if (Object.hasOwn(data, "concurrencyLimit")) {
    out.concurrencyLimit = normalizeInteger("concurrencyLimit", data.concurrencyLimit, CLIENT_KEY_POLICY_BOUNDS.maxConcurrency);
  }
  if (Object.hasOwn(data, "spendLimitUsd")) {
    const value = data.spendLimitUsd;
    if (value == null || value === "") out.spendLimitUsd = null;
    else if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > CLIENT_KEY_POLICY_BOUNDS.maxSpendUsd) {
      throw new Error(`spendLimitUsd must be finite from 0 through ${CLIENT_KEY_POLICY_BOUNDS.maxSpendUsd}`);
    } else out.spendLimitUsd = value;
  }
  return out;
}

const KEY_ROWS = `SELECT k.* FROM apiKeys k`;

export async function getClientKeySpend(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT spentUsd FROM apiKeys WHERE id = ?`, [id]);
  return Number(row?.spentUsd || 0);
}

export async function getApiKeys() {
  const db = await getAdapter();
  return db.all(`${KEY_ROWS} ORDER BY k.createdAt ASC`).map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  return rowToKey(db.get(`${KEY_ROWS} WHERE k.id = ?`, [id]));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const generated = generateApiKeyWithMachine(machineId);
  const packed = packApiKeyRecord(generated.key);
  const row = {
    id: uuidv4(),
    key: packed,
    name,
    machineId,
    isActive: 1,
    createdAt: new Date().toISOString(),
    allowedModels: null,
    allowedCombos: null,
    expiresAt: null,
    rateLimitPerMinute: null,
    concurrencyLimit: null,
    spendLimitUsd: null,
    spentUsd: 0,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, keyPrefix, lookupId, name, machineId, isActive, createdAt, allowedModels, allowedCombos, expiresAt, rateLimitPerMinute, concurrencyLimit, spendLimitUsd, spentUsd)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0)`,
    [row.id, packed, apiKeyPrefix(generated.key), generated.keyId, name, machineId, row.createdAt]
  );
  return { ...rowToKey(row), key: generated.key };
}

export async function updateApiKey(id, data) {
  const patch = normalizeClientKeyPatch(data);
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`${KEY_ROWS} WHERE k.id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const merged = { ...current, ...patch };
    db.run(
      `UPDATE apiKeys
       SET name = ?, isActive = ?, allowedModels = ?, allowedCombos = ?, expiresAt = ?, rateLimitPerMinute = ?, concurrencyLimit = ?, spendLimitUsd = ?
       WHERE id = ?`,
      [merged.name, merged.isActive ? 1 : 0, JSON.stringify(merged.allowedModels), JSON.stringify(merged.allowedCombos), merged.expiresAt,
        merged.rateLimitPerMinute, merged.concurrencyLimit, merged.spendLimitUsd, id]
    );
    result = { ...merged };
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  return (db.run(`DELETE FROM apiKeys WHERE id = ?`, [id])?.changes ?? 0) > 0;
}

export async function authenticateApiKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const db = await getAdapter();
  const lookupId = apiKeyLookupId(raw);
  let rows = lookupId
    ? db.all(`${KEY_ROWS} WHERE k.isActive = 1 AND k.lookupId = ? LIMIT 1`, [lookupId])
    : [];
  if (rows.length === 0) {
    rows = db.all(`${KEY_ROWS} WHERE k.isActive = 1 AND k.lookupId IS NULL AND k.key NOT LIKE 'v2:%'`);
  }
  for (const row of rows) {
    const unpacked = unpackApiKeyRecord(row.key);
    const matches = unpacked.version === 2
      ? await matchesApiKeyRecordAsync(row.key, raw)
      : matchesApiKeyRecord(row.key, raw);
    if (!matches) continue;
    if ((unpacked.legacy || unpacked.version === 1) && lookupId) {
      const packed = packApiKeyRecord(raw, lookupId);
      db.run(`UPDATE apiKeys SET key = ?, keyPrefix = ?, lookupId = ? WHERE id = ?`, [packed, apiKeyPrefix(raw), lookupId, row.id]);
      row.key = packed;
      row.keyPrefix = apiKeyPrefix(raw);
      row.lookupId = lookupId;
    }
    row.spentUsd = await getClientKeySpend(row.id);
    return rowToKey(row);
  }
  return null;
}

export async function validateApiKey(raw) {
  return !!(await authenticateApiKey(raw));
}
