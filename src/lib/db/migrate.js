import fs from "node:fs";
import path from "node:path";
import { LEGACY_FILES, DB_DIR, DATA_FILE, BACKUPS_DIR } from "./paths.js";
import { TABLES, buildCreateTableSql } from "./schema.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaSync, setMetaSync } from "./helpers/metaStoreSync.js";
import { makeBackupDir, backupFile, pruneOldBackups } from "./backup.js";
import { getAppVersion } from "./version.js";
import { stringifyJson } from "./helpers/jsonCol.js";
import { connToRow } from "./repos/connectionsRepo.js";
import { matchesApiKeyRecord, normalizeApiKeyRecordLookup, packApiKeyRecord, unpackApiKeyRecord } from "@/lib/crypto/secrets.js";
import { resolveClientKeyId, scrubUsageDailyData } from "./migrations/008-client-key-identity.js";
import { rebuildPrometheusMetrics } from "./migrations/009-prometheus-materialization.js";

// Marker file: prevents re-importing legacy JSON when user wipes data.sqlite.
const MIGRATED_MARKER = path.join(DB_DIR, ".migrated-from-json");
const LEGACY_SANITIZED_MARKER = path.join(DB_DIR, ".legacy-secrets-sanitized");

// Track per-adapter so reusing same adapter skips re-run, but new adapter (after reset) re-runs.
const _migratedAdapters = new WeakSet();
let _legacyKeyMatcher = matchesApiKeyRecord;

export function __setLegacyKeyMatcherForTests(matcher = matchesApiKeyRecord) {
  _legacyKeyMatcher = matcher;
}

// Thrown when row-count assertion fails. Outer transaction rolls back,
// legacy db.json kept intact, marker not written → next boot retries.
export class MigrationAborted extends Error {
  constructor(message, droppedRows) {
    super(message);
    this.name = "MigrationAborted";
    this.droppedRows = droppedRows;
  }
}

// Insert rows one-by-one, collect failures, then assert COUNT(*) matches input length.
function importWithAssertion(adapter, tableName, rows, insertFn, rowMeta) {
  const dropped = [];
  for (const row of rows) {
    try { insertFn(row); }
    catch (err) { dropped.push({ ...rowMeta(row), reason: err.message }); }
  }
  const inserted = adapter.get(`SELECT COUNT(*) as c FROM ${tableName}`)?.c ?? 0;
  if (inserted !== rows.length) {
    console.warn(`[DB][migrate] ${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}. Dropped:`, dropped);
    throw new MigrationAborted(`${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}`, dropped);
  }
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function buildLegacyKeyIdMap(data, usage, matchCache = new Map()) {
  const map = new Map();
  const records = [];
  for (const key of data?.apiKeys || []) {
    if (typeof key?.key !== "string" || !key.id) continue;
    const normalized = normalizeApiKeyRecordLookup(key.key);
    records.push({ id: key.id, stored: normalized });
    if (unpackApiKeyRecord(normalized).legacy) map.set(String(key.key), key.id);
  }
  const rawValues = new Set((usage?.history || []).map((entry) => entry?.apiKey).filter((raw) => typeof raw === "string" && raw !== "local-no-key"));
  for (const day of Object.values(usage?.dailySummary || {})) {
    for (const [counterKey, entry] of Object.entries(day?.byApiKey || {})) {
      const raw = typeof entry?.apiKey === "string" ? entry.apiKey : counterKey.split("|")[0];
      if (raw && raw !== "local-no-key") rawValues.add(String(raw));
    }
  }
  for (const raw of rawValues) {
    if (map.has(raw)) continue;
    const matched = records.find((record) => {
      const cacheKey = `${record.id}\u0000${record.stored}\u0000${raw}`;
      if (!matchCache.has(cacheKey)) matchCache.set(cacheKey, _legacyKeyMatcher(record.stored, raw));
      return matchCache.get(cacheKey);
    });
    if (matched) map.set(raw, matched.id);
  }
  return map;
}

function legacyImportTargetIsEmpty(adapter) {
  for (const table of ["settings", "providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails"]) {
    if ((adapter.get(`SELECT COUNT(*) count FROM ${table}`)?.count || 0) !== 0) return false;
  }
  return true;
}

function writeJsonRestricted(file, value) {
  if (!file || !fs.existsSync(path.dirname(file))) return;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function sanitizeLegacyPayload(legacyMain, legacyUsage, keys, storedById, legacyKeyIds = null, matchCache = new Map()) {
  const keyIds = legacyKeyIds || buildLegacyKeyIdMap(legacyMain, legacyUsage, matchCache);
  const main = legacyMain && typeof legacyMain === "object"
    ? {
        ...legacyMain,
        apiKeys: (legacyMain.apiKeys || []).map((key) => ({
          ...key,
          key: storedById.get(key.id) || null,
        })),
      }
    : null;
  const usage = legacyUsage && typeof legacyUsage === "object"
    ? {
        ...legacyUsage,
        history: (legacyUsage.history || []).map((entry) => ({
          ...entry,
          apiKey: null,
          clientKeyId: keyIds.get(String(entry.apiKey)) || entry.clientKeyId || null,
        })),
        dailySummary: Object.fromEntries(
          Object.entries(legacyUsage.dailySummary || {}).map(([dateKey, day]) => [
            dateKey,
            scrubUsageDailyData(day, keys, "up", (raw) => keyIds.get(String(raw)) || null),
          ])
        ),
      }
    : null;
  return { main, usage };
}

function sanitizeLegacySources(adapter, legacyMain, legacyUsage, _backupDir = null, legacyKeyIds = null, matchCache = new Map()) {
  const keys = adapter.all(`SELECT id, key FROM apiKeys`) || [];
  const storedById = new Map(keys.map((key) => [key.id, key.key]));
  const active = sanitizeLegacyPayload(legacyMain, legacyUsage, keys, storedById, legacyKeyIds, matchCache);
  if (active.main) writeJsonRestricted(LEGACY_FILES.main, active.main);
  if (active.usage) writeJsonRestricted(LEGACY_FILES.usage, active.usage);

  if (!fs.existsSync(BACKUPS_DIR)) return;
  for (const entry of fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("migrate-from-json-")) continue;
    const dir = path.join(BACKUPS_DIR, entry.name);
    const mainPath = path.join(dir, path.basename(LEGACY_FILES.main));
    const usagePath = path.join(dir, path.basename(LEGACY_FILES.usage));
    const backupMain = readJsonSafe(mainPath);
    const backupUsage = readJsonSafe(usagePath);
    const sanitized = sanitizeLegacyPayload(backupMain, backupUsage, keys, storedById, null, matchCache);
    if (sanitized.main) writeJsonRestricted(mainPath, sanitized.main);
    if (sanitized.usage) writeJsonRestricted(usagePath, sanitized.usage);
  }
}

function checkpointBeforeBackup(adapter) {
  try { adapter.checkpoint?.(); } catch {}
}

function isFreshDb(adapter) {
  // Table _meta may not exist yet on truly fresh DB
  try {
    const row = adapter.get(`SELECT COUNT(*) as c FROM _meta`);
    return !row || row.c === 0;
  } catch {
    return true;
  }
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
export function runVersionedMigrations(adapter) {
  // Bootstrap _meta first so we can read schemaVersion
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  const current = parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0;
  const target = latestVersion();
  if (current >= target) return { applied: 0, from: current, to: current };

  const pending = MIGRATIONS.filter((m) => m.version > current);
  let lastApplied = current;
  for (const m of pending) {
    adapter.transaction(() => m.up(adapter));
    if (typeof m.afterUp === "function") m.afterUp(adapter);
    adapter.transaction(() => setMetaSync(adapter, "schemaVersion", m.version));
    lastApplied = m.version;
    console.log(`[DB][migrate] applied #${m.version} ${m.name}`);
  }
  return { applied: pending.length, from: current, to: lastApplied };
}

// ─── Auto-sync (additive only): add missing tables/columns/indexes ───────
function syncSchemaFromTables(adapter) {
  for (const [tableName, def] of Object.entries(TABLES)) {
    // Create table if absent
    adapter.exec(buildCreateTableSql(tableName, def));

    // Diff columns
    const existing = adapter.all(`PRAGMA table_info(${tableName})`);
    const existingNames = new Set(existing.map((r) => r.name));
    for (const [colName, colDef] of Object.entries(def.columns)) {
      if (!existingNames.has(colName)) {
        // SQLite ADD COLUMN restrictions: no PRIMARY KEY / UNIQUE w/o NULL ok.
        // We strip PRIMARY KEY / UNIQUE since those are only valid at create time.
        const safeDef = colDef
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .trim();
        try {
          adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`);
          console.log(`[DB][sync] +column ${tableName}.${colName}`);
        } catch (e) {
          console.warn(`[DB][sync] add column ${tableName}.${colName} failed: ${e.message}`);
        }
      }
    }

    // Indexes (idempotent)
    for (const idx of def.indexes || []) {
      try { adapter.exec(idx); } catch {}
    }
  }
}

// ─── Legacy JSON import (one-time) ───────────────────────────────────────
function importLegacyMain(adapter, data) {
  if (!data || typeof data !== "object") return;

  if (data.settings) {
    adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(data.settings)]);
  }

  importWithAssertion(adapter, "providerConnections", data.providerConnections || [], (c) => {
    const row = connToRow(c);
    adapter.run(
      `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.provider, row.authType || "oauth", row.name, row.email, row.priority, row.isActive, row.data, row.createdAt || new Date().toISOString(), row.updatedAt || new Date().toISOString()]
    );
  }, (c) => ({ id: c.id ?? null, provider: c.provider ?? null, name: c.name ?? null }));

  importWithAssertion(adapter, "providerNodes", data.providerNodes || [], (n) => {
    const { id, type, name, createdAt, updatedAt, ...rest } = n;
    adapter.run(
      `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }, (n) => ({ id: n.id ?? null, type: n.type ?? null, name: n.name ?? null }));

  importWithAssertion(adapter, "proxyPools", data.proxyPools || [], (p) => {
    const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
    adapter.run(
      `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }, (p) => ({ id: p.id ?? null }));

  importWithAssertion(adapter, "apiKeys", data.apiKeys || [], (k) => {
    const normalizedKey = normalizeApiKeyRecordLookup(k.key);
    const storedKey = typeof normalizedKey === "string" && unpackApiKeyRecord(normalizedKey).legacy
      ? packApiKeyRecord(normalizedKey)
      : normalizedKey;
    const unpacked = unpackApiKeyRecord(storedKey);
    adapter.run(
      `INSERT OR REPLACE INTO apiKeys(id, key, keyPrefix, lookupDigest, name, machineId, isActive, createdAt, allowedModels, allowedCombos, expiresAt, rateLimitPerMinute, concurrencyLimit, spendLimitUsd, spentUsd)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [k.id, storedKey, unpacked.prefix || null, unpacked.lookupDigest || null, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(),
        k.allowedModels == null ? null : stringifyJson(k.allowedModels), k.allowedCombos == null ? null : stringifyJson(k.allowedCombos),
        k.expiresAt || null, k.rateLimitPerMinute ?? null, k.concurrencyLimit ?? null, k.spendLimitUsd ?? null, Number(k.spentUsd || 0)]
    );
  }, (k) => ({ id: k.id ?? null, name: k.name ?? null }));
  importWithAssertion(adapter, "combos", data.combos || [], (c) => {
    adapter.run(
      `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
    );
  }, (c) => ({ id: c.id ?? null, name: c.name ?? null }));

  for (const [alias, model] of Object.entries(data.modelAliases || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [alias, stringifyJson(model)]);
  }
  for (const m of data.customModels || []) {
    const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
  }
  for (const [tool, mappings] of Object.entries(data.mitmAlias || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
  }
  for (const [provider, models] of Object.entries(data.pricing || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
  }
}

function importLegacyUsage(adapter, data, legacyKeyIds = new Map()) {
  const keys = adapter.all(`SELECT id, key FROM apiKeys`) || [];
  if (!data || typeof data !== "object") return;
  for (const e of data.history || []) {
    const t = e.tokens || {};
    const clientKeyId = legacyKeyIds.get(String(e.apiKey)) || null;
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, clientKeyId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.timestamp || new Date().toISOString(),
        e.provider || null, e.model || null, e.connectionId || null, clientKeyId, e.endpoint || null,
        t.prompt_tokens || t.input_tokens || 0,
        t.completion_tokens || t.output_tokens || 0,
        e.cost || 0,
        e.status || "ok",
        stringifyJson(t),
        stringifyJson({}),
      ]
    );
    if (clientKeyId) {
      adapter.run(`UPDATE apiKeys SET spentUsd = spentUsd + ? WHERE id = ?`, [Number(e.cost || 0), clientKeyId]);
    }
  }
  for (const [dateKey, day] of Object.entries(data.dailySummary || {})) {
    adapter.run(
      `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
      [dateKey, stringifyJson(scrubUsageDailyData(day, keys, "up", (raw) => legacyKeyIds.get(String(raw)) || null))]
    );
  }
  if (typeof data.totalRequestsLifetime === "number") {
    setMetaSync(adapter, "totalRequestsLifetime", data.totalRequestsLifetime);
  }
}

function importLegacyDisabled(adapter, data) {
  if (!data || typeof data.disabled !== "object") return;
  for (const [provider, ids] of Object.entries(data.disabled)) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [provider, stringifyJson(ids || [])]);
  }
}

function importLegacyDetails(adapter, data) {
  if (!data || !Array.isArray(data.records)) return;
  for (const r of data.records) {
    adapter.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.timestamp || new Date().toISOString(), r.provider || null, r.model || null, r.connectionId || null, r.status || null, stringifyJson(r)]
    );
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────
export async function runMigrationOnce(adapter) {
  if (_migratedAdapters.has(adapter)) return;

  // Capture freshness BEFORE migrations stamp _meta (otherwise we'd misclassify
  // a brand-new DB as non-fresh once schemaVersion is written).
  const fresh = isFreshDb(adapter);

  // 1. Always run versioned migrations chain (skip-version safe)
  const migInfo = runVersionedMigrations(adapter);

  // 2. Additive sync (auto add missing columns/indexes declared in TABLES)
  syncSchemaFromTables(adapter);

  // 3. One-time legacy JSON import (only if DB was fresh on entry)
  const alreadyImported = fs.existsSync(MIGRATED_MARKER);
  const legacyMain = readJsonSafe(LEGACY_FILES.main);
  const legacyUsage = readJsonSafe(LEGACY_FILES.usage);
  const legacyDisabled = readJsonSafe(LEGACY_FILES.disabled);
  const legacyDetails = readJsonSafe(LEGACY_FILES.details);
  const hasLegacy = !!(legacyMain || legacyUsage || legacyDisabled || legacyDetails);
  const legacySanitized = fs.existsSync(LEGACY_SANITIZED_MARKER);
  const migrationProof = getMetaSync(adapter, "migratedAt", null);
  if (hasLegacy && !legacySanitized && migrationProof) {
    adapter.checkpoint?.();
    const legacyMatchCache = new Map();
    const legacyKeyIds = buildLegacyKeyIdMap(legacyMain, legacyUsage, legacyMatchCache);
    sanitizeLegacySources(adapter, legacyMain, legacyUsage, null, legacyKeyIds, legacyMatchCache);
    fs.writeFileSync(LEGACY_SANITIZED_MARKER, new Date().toISOString(), { mode: 0o600 });
  }

  const pendingLegacyImport = hasLegacy && !alreadyImported && !migrationProof;
  if (pendingLegacyImport && !legacyImportTargetIsEmpty(adapter)) {
    console.error("[DB][migrate] legacy import pending but target tables are not empty; preserving sources for repair");
    return;
  }

  if (pendingLegacyImport) {
    const t0 = Date.now();
    const backupDir = makeBackupDir("migrate-from-json");
    for (const f of Object.values(LEGACY_FILES)) backupFile(f, backupDir);
    const legacyMatchCache = new Map();
    const legacyKeyIds = buildLegacyKeyIdMap(legacyMain, legacyUsage, legacyMatchCache);

    try {
      adapter.transaction(() => {
        importLegacyMain(adapter, legacyMain);
        importLegacyUsage(adapter, legacyUsage, legacyKeyIds);
        importLegacyDisabled(adapter, legacyDisabled);
        importLegacyDetails(adapter, legacyDetails);
        rebuildPrometheusMetrics(adapter);
        setMetaSync(adapter, "appVersion", getAppVersion());
        setMetaSync(adapter, "migratedAt", new Date().toISOString());
      });
    } catch (err) {
      if (err instanceof MigrationAborted) {
        console.error(`[DB][migrate] aborted: ${err.message} | legacy JSON kept | backup: ${backupDir}`);
        return;
      }
      throw err;
    }

    adapter.checkpoint?.();
    sanitizeLegacySources(adapter, legacyMain, legacyUsage, backupDir, legacyKeyIds, legacyMatchCache);
    fs.writeFileSync(LEGACY_SANITIZED_MARKER, new Date().toISOString(), { mode: 0o600 });
    fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString(), { mode: 0o600 });
    pruneOldBackups();
    console.log(`[DB][migrate] JSON → SQLite in ${Date.now() - t0}ms | legacy sources sanitized | backup: ${backupDir}`);
    _migratedAdapters.add(adapter);
    return;
  }

  if (fresh) {
    setMetaSync(adapter, "appVersion", getAppVersion());
    _migratedAdapters.add(adapter);
    return;
  }

  // 4. App version bump → backup data.sqlite (safety net before user-side upgrade)
  const oldVer = getMetaSync(adapter, "appVersion", null);
  const newVer = getAppVersion();
  if (oldVer && oldVer !== newVer) {
    checkpointBeforeBackup(adapter);
    const backupDir = makeBackupDir(`upgrade-${oldVer}-to-${newVer}`);
    try { backupFile(DATA_FILE, backupDir); } catch {}
    setMetaSync(adapter, "appVersion", newVer);
    pruneOldBackups();
    console.log(`[DB][migrate] App ${oldVer} → ${newVer} | schema ${migInfo.from} → ${migInfo.to} | backup: ${backupDir}`);
  } else if (migInfo.applied > 0) {
    // Schema upgrade without app version bump — still backup
    checkpointBeforeBackup(adapter);
    const backupDir = makeBackupDir(`schema-${migInfo.from}-to-${migInfo.to}`);
    try { backupFile(DATA_FILE, backupDir); } catch {}
    pruneOldBackups();
  }
  _migratedAdapters.add(adapter);
}
