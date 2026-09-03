import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import {
  apiKeyLookupDigest,
  apiKeyPrefix,
  matchesApiKeyRecord,
  matchesApiKeyRecordAsync,
  packApiKeyRecord,
  timingSafeEqualStr,
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
    rotationRequired: unpacked.version !== 2 || !unpacked.lookupDigest,
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

// Verified-key memo: skips the ~40-80ms scrypt KDF when the proxy layer and
// the handler layer authenticate the same key twice per request (P3).
// Keyed by lookupDigest; stores only sha256(raw), never raw. TTL 60s, cap 256
// with LRU re-insert on hit. Policy fields are re-read by id on every hit so
// they stay fresh.
const VERIFY_MEMO_TTL_MS = 60_000;
const VERIFY_MEMO_MAX = 256;
/** @type {Map<string, { rawSha256: string, id: string, expiresAt: number }>} */
const verifyMemo = new Map();

function rawSha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function getVerifyMemo(lookupDigest, rawSha) {
  const entry = verifyMemo.get(lookupDigest);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    verifyMemo.delete(lookupDigest);
    return null;
  }
  // Wrong key with the same keyId: no hit, entry kept, caller runs the KDF.
  if (!timingSafeEqualStr(entry.rawSha256, rawSha)) return null;
  // LRU: re-insert to mark recent.
  verifyMemo.delete(lookupDigest);
  verifyMemo.set(lookupDigest, entry);
  return entry;
}

function setVerifyMemo(lookupDigest, rawSha, id) {
  if (verifyMemo.has(lookupDigest)) verifyMemo.delete(lookupDigest);
  else if (verifyMemo.size >= VERIFY_MEMO_MAX) {
    const oldest = verifyMemo.keys().next().value;
    if (oldest !== undefined) verifyMemo.delete(oldest);
  }
  verifyMemo.set(lookupDigest, { rawSha256: rawSha, id, expiresAt: Date.now() + VERIFY_MEMO_TTL_MS });
}

function invalidateVerifyMemoForId(id) {
  for (const [digest, entry] of verifyMemo) {
    if (entry.id === id) verifyMemo.delete(digest);
  }
}

function invalidateVerifyMemoForDigest(lookupDigest) {
  if (lookupDigest) verifyMemo.delete(lookupDigest);
}

export function __resetApiKeyVerifyMemoForTests() {
  verifyMemo.clear();
}

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
    `INSERT INTO apiKeys(id, key, keyPrefix, lookupDigest, name, machineId, isActive, createdAt, allowedModels, allowedCombos, expiresAt, rateLimitPerMinute, concurrencyLimit, spendLimitUsd, spentUsd)
     VALUES(?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0)`,
    [row.id, packed, apiKeyPrefix(generated.key), apiKeyLookupDigest(generated.key), name, machineId, row.createdAt]
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
  if (result) invalidateVerifyMemoForId(id);
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const ok = (db.run(`DELETE FROM apiKeys WHERE id = ?`, [id])?.changes ?? 0) > 0;
  if (ok) invalidateVerifyMemoForId(id);
  return ok;
}

export async function authenticateApiKey(raw) {
  if (!raw || typeof raw !== "string") return null;
  const db = await getAdapter();
  const lookupDigest = apiKeyLookupDigest(raw);
  const keyPrefix = apiKeyPrefix(raw);
  const rawSha = lookupDigest ? rawSha256(raw) : null;
  if (lookupDigest && rawSha) {
    const hit = getVerifyMemo(lookupDigest, rawSha);
    if (hit) {
      const fresh = db.get(`${KEY_ROWS} WHERE k.id = ?`, [hit.id]);
      if (fresh && (fresh.isActive === 1 || fresh.isActive === true)) {
        fresh.spentUsd = await getClientKeySpend(fresh.id);
        return rowToKey(fresh);
      }
      verifyMemo.delete(lookupDigest);
    }
  }
  const indexed = lookupDigest
    ? db.get(`${KEY_ROWS} WHERE k.isActive = 1 AND k.lookupDigest = ?`, [lookupDigest])
    : null;

  if (indexed) {
    const matches = unpackApiKeyRecord(indexed.key).version === 2
      ? await matchesApiKeyRecordAsync(indexed.key, raw)
      : matchesApiKeyRecord(indexed.key, raw);
    if (!matches) return null;
    if (lookupDigest && rawSha) setVerifyMemo(lookupDigest, rawSha, indexed.id);
    indexed.spentUsd = await getClientKeySpend(indexed.id);
    return rowToKey(indexed);
  }

  const legacyRows = db.all(
    `${KEY_ROWS} WHERE k.isActive = 1 AND k.lookupDigest IS NULL AND k.keyPrefix = ? AND k.key NOT LIKE 'v2:%'`,
    [keyPrefix],
  );
  for (const row of legacyRows) {
    const unpacked = unpackApiKeyRecord(row.key);
    if (!matchesApiKeyRecord(row.key, raw)) continue;
    if (unpacked.legacy || (unpacked.version === 1 && lookupDigest)) {
      const packed = packApiKeyRecord(raw, lookupDigest);
      db.run(
        `UPDATE apiKeys SET key = ?, keyPrefix = ?, lookupDigest = ? WHERE id = ?`,
        [packed, apiKeyPrefix(raw), lookupDigest, row.id],
      );
      // Drop any stale memo entry for this digest before re-populating below.
      invalidateVerifyMemoForDigest(lookupDigest);
      row.key = packed;
      row.keyPrefix = apiKeyPrefix(raw);
      row.lookupDigest = lookupDigest;
    }
    if (lookupDigest && rawSha) setVerifyMemo(lookupDigest, rawSha, row.id);
    row.spentUsd = await getClientKeySpend(row.id);
    return rowToKey(row);
  }
  return null;
}

export async function validateApiKey(raw) {
  return !!(await authenticateApiKey(raw));
}
