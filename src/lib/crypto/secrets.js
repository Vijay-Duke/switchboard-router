/**
 * At-rest encryption for sensitive credential fields (H2).
 * AES-256-GCM. Formats:
 *   enc:v1:<ivHex>:<tagHex>:<cipherHex>  key = auth/data-key (legacy, read-only)
 *   enc:v2:<ivHex>:<tagHex>:<cipherHex>  key = sha256(data-key || auth/cli-secret)
 * v1 blobs stay readable so an upgrade never drops stored credentials; they
 * move to v2 whenever the row is next written (encryptSecret always emits v2
 * once the cli-secret exists).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

const ALGO = "aes-256-gcm";
const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";
const KEY_FILE = path.join(DATA_DIR, "auth", "data-key");
const CLI_SECRET_FILE = path.join(DATA_DIR, "auth", "cli-secret");
const FALLBACK_SALT = "switchboard-at-rest-v1";

let cachedBaseKey = null;
let cachedCliSecret = null;

// Same file and format as shared/utils/machineId.js loadCliSecret (not
// exported there). Created here as well so runtimes that never see the CLI
// (Docker, `npm run dev`) still get a v2 key; `wx` keeps a concurrent creator's
// value instead of clobbering it. Returns null when the data dir is read-only.
function loadOrCreateCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim() || null;
    if (cachedCliSecret) return cachedCliSecret;
  } catch { /* create */ }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(CLI_SECRET_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CLI_SECRET_FILE, generated, { mode: 0o600, flag: "wx" });
    cachedCliSecret = generated;
  } catch {
    try {
      cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, "utf8").trim() || null;
    } catch {
      cachedCliSecret = null;
    }
  }
  return cachedCliSecret;
}

function loadOrCreateBaseKey() {
  if (cachedBaseKey) return cachedBaseKey;
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) {
      cachedBaseKey = raw;
      return cachedBaseKey;
    }
  } catch { /* create */ }
  try {
    // Prefer machine-id when available; otherwise random (persisted below)
    const midPath = path.join(DATA_DIR, "machine-id");
    let seed = FALLBACK_SALT;
    try {
      seed = fs.readFileSync(midPath, "utf8").trim() + FALLBACK_SALT;
    } catch { /* random below if empty */ }
    if (seed === FALLBACK_SALT) {
      cachedBaseKey = crypto.randomBytes(32);
    } else {
      cachedBaseKey = crypto.createHash("sha256").update(seed).digest();
    }
  } catch {
    cachedBaseKey = crypto.randomBytes(32);
  }
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, cachedBaseKey, { mode: 0o600 });
  } catch { /* best-effort persist */ }
  return cachedBaseKey;
}

// v2 key: data-key mixed with the random per-install cli-secret, so the key
// is not derivable from public identifiers (machine-id) alone. Null when no
// secret can be read or created (then encryption stays on v1).
function loadV2Key() {
  const cliSecret = loadOrCreateCliSecret();
  if (!cliSecret) return null;
  return crypto.createHash("sha256").update(loadOrCreateBaseKey()).update(cliSecret, "utf8").digest();
}

export function __resetSecretsKeyForTests() {
  cachedBaseKey = null;
  cachedCliSecret = null;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (typeof plaintext !== "string") return plaintext;
  if (plaintext.startsWith(PREFIX_V1) || plaintext.startsWith(PREFIX_V2)) return plaintext; // already encrypted
  const v2Key = loadV2Key();
  const key = v2Key || loadOrCreateBaseKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${v2Key ? PREFIX_V2 : PREFIX_V1}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored) {
  if (stored == null || stored === "") return stored;
  if (typeof stored !== "string") return stored;
  const isV2 = stored.startsWith(PREFIX_V2);
  if (!isV2 && !stored.startsWith(PREFIX_V1)) return stored; // legacy plaintext
  try {
    const rest = stored.slice(PREFIX_V2.length); // both prefixes share a length
    const [ivHex, tagHex, dataHex] = rest.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = isV2 ? loadV2Key() : loadOrCreateBaseKey();
    if (!key) return null; // v2 blob but the cli-secret is gone → "not set"
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex"), undefined, "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/** Hash a gateway API key for storage (H3). */
export function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(`sb-key:${rawKey}`).digest("hex");
}

/** Display prefix: first 10 chars of the key for list UI. */
export function apiKeyPrefix(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return "";
  return rawKey.length <= 12 ? rawKey.slice(0, 4) + "…" : rawKey.slice(0, 10) + "…";
}

export function apiKeyLookupDigestFromKeyId(keyId) {
  if (typeof keyId !== "string" || !/^[a-f0-9]{32}$/.test(keyId)) return null;
  return crypto.createHash("sha256").update(`sb-key-lookup:${keyId}`).digest("hex");
}

export function apiKeyLookupDigest(rawKey) {
  if (typeof rawKey !== "string") return null;
  const parts = rawKey.split("-");
  if (parts.length !== 4 || parts[0] !== "sk" || !parts[1] || !/^[a-f0-9]{8}$/.test(parts[3])) return null;
  return apiKeyLookupDigestFromKeyId(parts[2]);
}

/** Stored forms: v2:<lookupDigest>:<prefix>:<saltHex>:<scryptHex> or cheap legacy v1. */
export function packApiKeyRecord(rawKey, lookupDigest = apiKeyLookupDigest(rawKey)) {
  if (!lookupDigest) {
    // Low-entropy legacy keys remain on the cheap verifier until explicit rotation.
    return `v1:${apiKeyPrefix(rawKey)}:${hashApiKey(rawKey)}`;
  }
  const salt = crypto.randomBytes(16);
  const verifier = crypto.scryptSync(rawKey, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `v2:${lookupDigest}:${apiKeyPrefix(rawKey)}:${salt.toString("hex")}:${verifier.toString("hex")}`;
}

export function normalizeApiKeyRecordLookup(stored) {
  if (typeof stored !== "string" || !stored.startsWith("v2:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 5 || !/^[a-f0-9]{32}$/.test(parts[1])) return stored;
  const digest = apiKeyLookupDigestFromKeyId(parts[1]);
  return `v2:${digest}:${parts[2]}:${parts[3]}:${parts[4]}`;
}

export function unpackApiKeyRecord(stored) {
  if (!stored || typeof stored !== "string") return { version: 0, lookupDigest: null, prefix: "", hash: null, salt: null, legacy: true, raw: stored };
  const normalized = normalizeApiKeyRecordLookup(stored);
  const parts = normalized.split(":");
  if (normalized.startsWith("v2:") && parts.length === 5) {
    const lookupDigest = /^[a-f0-9]{64}$/.test(parts[1]) ? parts[1] : null;
    return { version: 2, lookupDigest, prefix: parts[2], salt: parts[3], hash: parts[4], legacy: false, raw: null };
  }
  if (normalized.startsWith("v2:") && parts.length === 4) {
    return { version: 2, lookupDigest: null, prefix: parts[1], salt: parts[2], hash: parts[3], legacy: false, raw: null };
  }
  if (normalized.startsWith("v1:") && parts.length >= 3) {
    return { version: 1, lookupDigest: null, prefix: parts[1], salt: null, hash: parts.slice(2).join(":"), legacy: false, raw: null };
  }
  return { version: 0, lookupDigest: apiKeyLookupDigest(normalized), prefix: apiKeyPrefix(normalized), hash: null, salt: null, legacy: true, raw: normalized };
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Hash both sides to a fixed width so length mismatches do not return early.
  const ba = crypto.createHash("sha256").update(a).digest();
  const bb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ba, bb);
}

export function matchesApiKeyRecord(stored, raw) {
  if (!raw || typeof raw !== "string") return false;
  const unpacked = unpackApiKeyRecord(stored);
  if (unpacked.legacy) return timingSafeEqualStr(String(unpacked.raw || ""), raw);
  if (unpacked.version === 1) return !!unpacked.hash && timingSafeEqualStr(unpacked.hash, hashApiKey(raw));
  if (!unpacked.salt || !unpacked.hash) return false;
  try {
    const actual = crypto.scryptSync(raw, Buffer.from(unpacked.salt, "hex"), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqualStr(actual.toString("hex"), unpacked.hash);
  } catch {
    return false;
  }
}

export async function matchesApiKeyRecordAsync(stored, raw) {
  if (!raw || typeof raw !== "string") return false;
  const unpacked = unpackApiKeyRecord(stored);
  if (unpacked.version !== 2) return matchesApiKeyRecord(stored, raw);
  if (!unpacked.salt || !unpacked.hash) return false;
  try {
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(raw, Buffer.from(unpacked.salt, "hex"), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
    return timingSafeEqualStr(actual.toString("hex"), unpacked.hash);
  } catch {
    return false;
  }
}
