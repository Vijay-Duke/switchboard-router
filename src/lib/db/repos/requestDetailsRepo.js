import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { registerAdapterCloser } from "../adapters/adapterShutdownRegistry.js";
import { noteBodyLength } from "../../../../open-sse/utils/usageTracking.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
/** Cap each JSON field at 5 KB by default (was unbounded in memory until flush). */
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
/**
 * Hard cap on buffered unflushed records to prevent OOM under load (#2472).
 * This is a last-resort memory guard, not a throughput limit: saveRequestDetail
 * awaits its config before buffering, so a burst arrives all at once and only
 * drains after the first async flush completes. At 100 (5 batches) a moderately
 * busy gateway silently dropped most of its observability rows. Fields are
 * already truncated to maxJsonSize on push, so 5000 records is a few MB.
 */
const DEFAULT_MAX_BUFFER = 5000;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      maxBuffer: parseInt(process.env.OBSERVABILITY_MAX_BUFFER || String(DEFAULT_MAX_BUFFER), 10) || DEFAULT_MAX_BUFFER,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      maxBuffer: DEFAULT_MAX_BUFFER,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

const DROP_WARN_INTERVAL_MS = 60_000;
let lastDropWarnAt = 0;
let droppedSinceLastWarn = 0;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "x-switchboard-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const REDACTED_BODY_VALUE = "[REDACTED]";

// Secret-typed keys stripped from stored request/response bodies (same idea as
// SECRET_FIELDS in connectionsRepo.js, plus header-style names), matched
// case-insensitively with -/_ ignored so apiKey/api_key/API-KEY all hit.
// Exact-name match only: "tokens" (prompt/completion counts) must survive.
const BODY_SECRET_KEYS = new Set([
  "accesstoken", "refreshtoken", "idtoken", "apikey", "copilottoken",
  "cookies", "clientsecret", "secretaccesskey",
  "authorization", "xapikey", "xswitchboardkey", "cookie", "token",
  "password", "passwd", "secret", "bearer", "setcookie", "xauthtoken",
]);

function isSecretBodyKey(key) {
  return BODY_SECRET_KEYS.has(String(key).toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Deep-strip secret-typed values from a stored body. Never mutates the input;
 * secret values (string or nested) become "[REDACTED]". Copy-on-write: a body
 * with nothing to redact is returned by reference so the identity-keyed
 * truncation memo below (P8) still hits for the common clean case.
 * @param {*} value
 * @param {WeakSet<object>} [seen] cycle guard (truncateField tolerates cycles; so must this)
 */
export function sanitizeBody(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  let out = null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const nv = sanitizeBody(value[i], seen);
      if (nv !== value[i] && !out) out = value.slice();
      if (out) out[i] = nv;
    }
    return out || value;
  }
  for (const [k, v] of Object.entries(value)) {
    const nv = isSecretBodyKey(k) ? REDACTED_BODY_VALUE : sanitizeBody(v, seen);
    if (nv !== v && !out) out = { ...value };
    if (out) out[k] = nv;
  }
  return out || value;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

/**
 * Memoize truncateField by object identity: streaming requests save the same
 * `request`/`providerRequest` references twice (start + finish), so the
 * second pass reuses the first pass's result instead of re-serializing a
 * large agent context. Objects passed here are not mutated after dispatch
 * (RTK/headroom mutate before executor.execute), so identity memo is safe.
 */
const truncMemo = new WeakMap();

function memoizeTruncation(obj, maxSize, result) {
  if (obj && (typeof obj === "object" || typeof obj === "function")) {
    try {
      truncMemo.set(obj, { maxSize, result });
    } catch {
      /* ignore non-keyable values */
    }
  }
  return result;
}

/**
 * Truncate a field if its JSON serialization exceeds maxSize.
 * Returns a small preview object instead of the full payload.
 * Safe for circular structures / non-JSON values (falls back to preview of String()).
 */
function truncateField(obj, maxSize) {
  if (obj == null) return {};
  if ((typeof obj === "object" || typeof obj === "function")) {
    try {
      const hit = truncMemo.get(obj);
      if (hit && hit.maxSize === maxSize) return hit.result;
    } catch {
      /* ignore memo lookup failures */
    }
  }
  let str;
  try {
    str = JSON.stringify(obj);
  } catch {
    const preview = String(obj).substring(0, 200);
    return memoizeTruncation(obj, maxSize, { _truncated: true, _originalSize: preview.length, _preview: preview, _error: "stringify_failed" });
  }
  // Share the measured length with the usage estimator so a later
  // estimateInputTokens on the same body skips its own stringify.
  noteBodyLength(obj, str.length);
  if (str.length > maxSize) {
    return memoizeTruncation(obj, maxSize, { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) });
  }
  return memoizeTruncation(obj, maxSize, obj);
}

/**
 * Shrink a detail record before it enters the write buffer so large agent
 * payloads (tool schemas, multi-turn history, images) never sit untruncated
 * in heap. Addresses Switchboard#2472 OOM from requestDetails bloat.
 */
function shrinkDetail(detail, maxJsonSize) {
  if (!detail || typeof detail !== "object") return detail;
  const out = { ...detail };
  if (out.request?.headers) {
    out.request = { ...out.request, headers: sanitizeHeaders(out.request.headers) };
  }
  out.request = truncateField(sanitizeBody(out.request), maxJsonSize);
  out.providerRequest = truncateField(sanitizeBody(out.providerRequest), maxJsonSize);
  out.providerResponse = truncateField(sanitizeBody(out.providerResponse), maxJsonSize);
  out.response = truncateField(sanitizeBody(out.response), maxJsonSize);
  // Drop accidental full-body clones nested under unknown keys
  if (out.body) out.body = truncateField(sanitizeBody(out.body), maxJsonSize);
  if (out.raw) out.raw = truncateField(sanitizeBody(out.raw), maxJsonSize);
  return out;
}

function buildDetailRecord(item, config) {
  if (!item.id) item.id = generateDetailId(item.model);
  if (!item.timestamp) item.timestamp = new Date().toISOString();

  // Fields already truncated on push; re-truncate defensively in case
  // maxJsonSize was lowered between push and flush.
  return {
    id: item.id,
    provider: item.provider || null,
    model: item.model || null,
    connectionId: item.connectionId || null,
    timestamp: item.timestamp,
    status: item.status || null,
    latency: item.latency || {},
    tokens: item.tokens || {},
    request: truncateField(item.request, config.maxJsonSize),
    providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
    providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
    response: truncateField(item.response, config.maxJsonSize),
    pxpipe: item.pxpipe || undefined,
    // Cap hits: one entry per compressed tool_result; pathological histories stay bounded.
    rtk: item.rtk ? { ...item.rtk, hits: item.rtk.hits?.slice(0, 50) } : undefined,
  };
}

function insertDetailItemsSync(db, config, items) {
  db.transaction(() => {
    for (const item of items) {
      const record = buildDetailRecord(item, config);
      db.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
        [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
      );
    }

    // Retention via a single index-seek cutoff + range delete (both use
    // idx_rd_ts), so an under-cap flush pays one seek instead of a
    // full-table pass. The cutoff is the oldest row to keep; rows sharing
    // its exact timestamp survive, which is acceptable.
    const cut = db.get(
      `SELECT timestamp FROM requestDetails ORDER BY timestamp DESC LIMIT 1 OFFSET ?`,
      [Math.max(0, config.maxRecords - 1)]
    );
    if (cut) {
      db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cut.timestamp]);
    }
  });
}

// Last-known live adapter + config for the synchronous SIGTERM/SIGINT drain.
// Refresh on every flush (and best-effort on save) so a signal that arrives
// before any async flush still has something to write through.
let lastSyncAdapter = null;
let lastSyncConfig = null;

/**
 * Synchronously drain the write buffer (SIGTERM/SIGINT path — signals cannot
 * await). Best-effort: returns the flushed count, never throws.
 */
export function flushRequestDetailsSync() {
  if (writeBuffer.length === 0) return 0;
  const db = lastSyncAdapter;
  const config = lastSyncConfig;
  if (!db || !config) return 0;
  try {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const items = writeBuffer.splice(0, writeBuffer.length);
    try {
      insertDetailItemsSync(db, config, items);
    } catch {
      writeBuffer.unshift(...items);
      return 0;
    }
    return items.length;
  } catch {
    return 0;
  }
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  let failure = null;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      try {
        const db = await getAdapter();
        const config = await getObservabilityConfig();
        lastSyncAdapter = db;
        lastSyncConfig = config;
        insertDetailItemsSync(db, config, items);
      } catch (e) {
        // A spliced batch must never vanish silently (e.g. transient
        // SQLITE_BUSY): re-queue it at the front and stop draining; the next
        // save retries the flush.
        failure = e;
        writeBuffer.unshift(...items);
        break;
      }
    }
  } finally {
    isFlushing = false;
  }
  if (failure) console.error("[requestDetailsRepo] Batch write failed:", failure);
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;
  lastSyncConfig = config;
  // Best-effort adapter handle for the sync signal drain. Fire-and-forget so
  // a slow/failing init never delays the save path.
  try {
    getAdapter().then(
      (db) => { lastSyncAdapter = db; },
      () => {}
    );
  } catch { /* ignore */ }

  // Truncate large payloads BEFORE buffering so heap stays bounded (#2472).
  const shrunk = shrinkDetail(detail, config.maxJsonSize);

  // Drop oldest if buffer is full (prefer recent errors over old successes).
  // Never drop silently — a quiet truncation reads as "we captured everything".
  if (writeBuffer.length >= config.maxBuffer) {
    writeBuffer.shift();
    droppedSinceLastWarn++;
    const now = Date.now();
    if (now - lastDropWarnAt > DROP_WARN_INTERVAL_MS) {
      console.warn(
        `[requestDetailsRepo] observability buffer full (${config.maxBuffer}); dropped ${droppedSinceLastWarn} record(s). Raise OBSERVABILITY_MAX_BUFFER or lower OBSERVABILITY_FLUSH_INTERVAL_MS.`
      );
      lastDropWarnAt = now;
      droppedSinceLastWarn = 0;
    }
  }
  writeBuffer.push(shrunk);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  const isoOrNull = (value) => {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const startIso = filter.startDate ? isoOrNull(filter.startDate) : null;
  const endIso = filter.endDate ? isoOrNull(filter.endDate) : null;
  if (startIso) { conds.push("timestamp >= ?"); params.push(startIso); }
  if (endIso) { conds.push("timestamp <= ?"); params.push(endIso); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

export const flushPendingRequestDetails = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

const BEFORE_EXIT_HANDLER_SLOT = "__switchboardRequestDetailsBeforeExitHandler";
const SYNC_FLUSH_SLOT = "__switchboardRequestDetailsSyncFlushUnregister";

function ensureShutdownHandler() {
  const previousHandler = globalThis[BEFORE_EXIT_HANDLER_SLOT];
  if (previousHandler) process.off("beforeExit", previousHandler);
  globalThis[BEFORE_EXIT_HANDLER_SLOT] = flushPendingRequestDetails;
  process.on("beforeExit", flushPendingRequestDetails);
}

function ensureSyncFlushRegistered() {
  try {
    const previousUnregister = globalThis[SYNC_FLUSH_SLOT];
    if (typeof previousUnregister === "function") {
      try { previousUnregister(); } catch { /* ignore */ }
    }
    // Runs on beforeExit AND synchronously on SIGTERM/SIGINT via the adapter
    // shutdown registry, so buffered rows survive docker stop / restart.
    globalThis[SYNC_FLUSH_SLOT] = registerAdapterCloser(flushRequestDetailsSync, { flush: true });
  } catch { /* registry unavailable — beforeExit handler still covers clean exits */ }
}

ensureShutdownHandler();
ensureSyncFlushRegistered();
