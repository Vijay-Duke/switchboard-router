import {
  matchesApiKeyRecord,
  packApiKeyRecord,
  unpackApiKeyRecord,
} from "../../crypto/secrets.js";

const POLICY_COLUMNS = {
  allowedModels: "TEXT",
  allowedCombos: "TEXT",
  expiresAt: "TEXT",
  rateLimitPerMinute: "INTEGER",
  concurrencyLimit: "INTEGER",
  spendLimitUsd: "REAL",
  spentUsd: "REAL NOT NULL DEFAULT 0",
};

function columns(db, table) {
  return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
}

function addPolicyColumns(db) {
  const existing = columns(db, "apiKeys");
  for (const [name, type] of Object.entries(POLICY_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE apiKeys ADD COLUMN ${name} ${type}`);
  }
}

export function resolveClientKeyId(raw, keys) {
  if (!raw || raw === "local-no-key") return null;
  return keys.find((key) => matchesApiKeyRecord(key.key, String(raw)))?.id || null;
}

function mergeCounter(target, incoming) {
  if (!target) return structuredClone(incoming);
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === "number") target[key] = (Number(target[key]) || 0) + value;
    else if (!(key in target)) target[key] = structuredClone(value);
  }
  return target;
}

export function scrubUsageDailyData(data, keys = [], direction = "up") {
  const day = data && typeof data === "object" ? structuredClone(data) : {};
  if (direction === "down") {
    const source = day.byClientKey && typeof day.byClientKey === "object" ? day.byClientKey : {};
    const byApiKey = {};
    for (const entry of Object.values(source)) {
      const rawModel = entry?.rawModel ?? "unknown";
      const provider = entry?.provider ?? "unknown";
      const counter = { ...entry, apiKey: null };
      delete counter.clientKeyId;
      const counterKey = `local-no-key|${rawModel}|${provider || "unknown"}`;
      byApiKey[counterKey] = mergeCounter(byApiKey[counterKey], counter);
    }
    delete day.byClientKey;
    day.byApiKey = byApiKey;
    return day;
  }

  const source = day.byApiKey && typeof day.byApiKey === "object" ? day.byApiKey : {};
  const byClientKey = day.byClientKey && typeof day.byClientKey === "object"
    ? structuredClone(day.byClientKey)
    : {};
  for (const [oldKey, entry] of Object.entries(source)) {
    const raw = typeof entry?.apiKey === "string" ? entry.apiKey : oldKey.split("|")[0];
    const clientKeyId = resolveClientKeyId(raw, keys);
    const rawModel = entry?.rawModel ?? oldKey.split("|")[1] ?? "unknown";
    const provider = entry?.provider ?? oldKey.split("|")[2] ?? "unknown";
    const counter = { ...entry, clientKeyId };
    delete counter.apiKey;
    delete counter.apiKeyMasked;
    delete counter.apiKeyKey;
    const counterKey = `${clientKeyId || "local-no-key"}|${rawModel}|${provider || "unknown"}`;
    byClientKey[counterKey] = mergeCounter(byClientKey[counterKey], counter);
  }
  delete day.byApiKey;
  day.byClientKey = byClientKey;
  return day;
}

function totals(db) {
  const row = db.get(`
    SELECT COUNT(*) count,
           COALESCE(SUM(promptTokens), 0) prompt,
           COALESCE(SUM(completionTokens), 0) completion,
           COALESCE(SUM(cost), 0) cost
    FROM usageHistory
  `);
  return [Number(row?.count || 0), Number(row?.prompt || 0), Number(row?.completion || 0), Number(row?.cost || 0)];
}

function assertTotals(before, after) {
  if (before.some((value, index) => value !== after[index])) {
    throw new Error("client key identity migration changed usage totals");
  }
}

function createV8UsageHistory(db) {
  db.exec(`
    CREATE TABLE usageHistory_v8 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      connectionId TEXT,
      clientKeyId TEXT,
      endpoint TEXT,
      promptTokens INTEGER DEFAULT 0,
      completionTokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      status TEXT,
      tokens TEXT,
      meta TEXT,
      requestId TEXT
    )
  `);
}

function createV7UsageHistory(db) {
  db.exec(`
    CREATE TABLE usageHistory_v7 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      connectionId TEXT,
      apiKey TEXT,
      endpoint TEXT,
      promptTokens INTEGER DEFAULT 0,
      completionTokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      status TEXT,
      tokens TEXT,
      meta TEXT,
      requestId TEXT
    )
  `);
}

function createUsageIndexes(db, identityColumn) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider);
    CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model);
    CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId);
    ${identityColumn === "clientKeyId" ? "CREATE INDEX IF NOT EXISTS idx_uh_client_key ON usageHistory(clientKeyId);" : ""}
    CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_request_id ON usageHistory(requestId) WHERE requestId IS NOT NULL;
  `);
}

function rewriteDaily(db, keys, direction) {
  const rows = db.all(`SELECT dateKey, data FROM usageDaily`) || [];
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { parsed = {}; }
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [JSON.stringify(scrubUsageDailyData(parsed, keys, direction)), row.dateKey]);
  }
}

const migration = {
  version: 8,
  name: "client-key-identity",
  up(db) {
    db.exec(`PRAGMA secure_delete=ON`);
    addPolicyColumns(db);
    const keys = db.all(`SELECT id, key FROM apiKeys`) || [];
    const usageColumns = columns(db, "usageHistory");

    if (usageColumns.has("apiKey")) {
      const before = totals(db);
      const rows = db.all(`SELECT * FROM usageHistory ORDER BY id`) || [];
      db.exec(`DROP TABLE IF EXISTS usageHistory_v8`);
      createV8UsageHistory(db);
      for (const row of rows) {
        db.run(
          `INSERT INTO usageHistory_v8(id, timestamp, provider, model, connectionId, clientKeyId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.timestamp, row.provider, row.model, row.connectionId, resolveClientKeyId(row.apiKey, keys), row.endpoint,
            row.promptTokens, row.completionTokens, row.cost, row.status, row.tokens, row.meta, row.requestId]
        );
      }
      db.exec(`DROP TABLE usageHistory; ALTER TABLE usageHistory_v8 RENAME TO usageHistory`);
      createUsageIndexes(db, "clientKeyId");
      assertTotals(before, totals(db));
    } else {
      createUsageIndexes(db, "clientKeyId");
    }

    rewriteDaily(db, keys, "up");
    db.exec(`
      UPDATE apiKeys
      SET spentUsd = MAX(
        COALESCE(spentUsd, 0),
        COALESCE((SELECT SUM(cost) FROM usageHistory WHERE clientKeyId = apiKeys.id), 0)
      )
    `);
    for (const key of keys) {
      if (unpackApiKeyRecord(key.key).legacy) {
        db.run(`UPDATE apiKeys SET key = ? WHERE id = ?`, [packApiKeyRecord(String(key.key)), key.id]);
      }
    }
  },
  down(db) {
    const usageColumns = columns(db, "usageHistory");
    if (usageColumns.has("apiKey")) return;
    const before = totals(db);
    const rows = db.all(`SELECT * FROM usageHistory ORDER BY id`) || [];
    db.exec(`DROP TABLE IF EXISTS usageHistory_v7`);
    createV7UsageHistory(db);
    for (const row of rows) {
      db.run(
        `INSERT INTO usageHistory_v7(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.timestamp, row.provider, row.model, row.connectionId, row.endpoint,
          row.promptTokens, row.completionTokens, row.cost, row.status, row.tokens, row.meta, row.requestId]
      );
    }
    db.exec(`DROP TABLE usageHistory; ALTER TABLE usageHistory_v7 RENAME TO usageHistory`);
    createUsageIndexes(db, "apiKey");
    rewriteDaily(db, [], "down");
    assertTotals(before, totals(db));
  },
  afterUp(db) {
    db.checkpoint?.();
    db.exec(`VACUUM`);
    db.checkpoint?.();
  },
};

export default migration;
