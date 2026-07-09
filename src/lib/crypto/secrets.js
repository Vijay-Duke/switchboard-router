/**
 * At-rest encryption for sensitive credential fields (H2).
 * AES-256-GCM with a machine-id-derived key (same pattern as MITM sudo password).
 * Format: enc:v1:<ivHex>:<tagHex>:<cipherHex>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";
const KEY_FILE = path.join(DATA_DIR, "auth", "data-key");
const FALLBACK_SALT = "switchboard-at-rest-v1";

let cachedKey = null;

function loadOrCreateKey() {
  if (cachedKey) return cachedKey;
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
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
      cachedKey = crypto.randomBytes(32);
    } else {
      cachedKey = crypto.createHash("sha256").update(seed).digest();
    }
  } catch {
    cachedKey = crypto.randomBytes(32);
  }
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
  } catch { /* best-effort persist */ }
  return cachedKey;
}

export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (typeof plaintext !== "string") return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const key = loadOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored) {
  if (stored == null || stored === "") return stored;
  if (typeof stored !== "string") return stored;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const rest = stored.slice(PREFIX.length);
    const [ivHex, tagHex, dataHex] = rest.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = loadOrCreateKey();
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

/** Stored form: v1:<prefix>:<hash> */
export function packApiKeyRecord(rawKey) {
  return `v1:${apiKeyPrefix(rawKey)}:${hashApiKey(rawKey)}`;
}

export function unpackApiKeyRecord(stored) {
  if (!stored || typeof stored !== "string") return { prefix: "", hash: null, legacy: true, raw: stored };
  if (stored.startsWith("v1:")) {
    const parts = stored.split(":");
    // v1:prefix:hash — prefix may contain "…" only
    if (parts.length >= 3) {
      return { prefix: parts[1], hash: parts.slice(2).join(":"), legacy: false, raw: null };
    }
  }
  return { prefix: apiKeyPrefix(stored), hash: null, legacy: true, raw: stored };
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
