import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { packApiKeyRecord } from "@/lib/crypto/secrets.js";
import migration from "@/lib/db/migrations/008-client-key-identity.js";
import { MIGRATIONS } from "@/lib/db/migrations/index.js";
import { runVersionedMigrations } from "@/lib/db/migrate.js";

const RAW_KEY = "sk-switchboard-migration-known-secret";
const LEGACY_KEY = "legacy-switchboard-migration-secret";
const UNKNOWN_KEY = "sk-switchboard-unmatched-secret";

const tempPaths = [];

afterEach(() => {
  for (const file of tempPaths.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

async function createVersion7Fixture() {
  const file = path.join(os.tmpdir(), `switchboard-client-key-migration-${crypto.randomUUID()}.sqlite`);
  tempPaths.push(file);
  const db = await createNodeSqliteAdapter(file);
  db.exec(`
    CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      machineId TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE usageHistory (
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
    );
    CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
    CREATE INDEX idx_uh_provider ON usageHistory(provider);
    CREATE INDEX idx_uh_model ON usageHistory(model);
    CREATE INDEX idx_uh_conn ON usageHistory(connectionId);
    CREATE UNIQUE INDEX idx_uh_request_id ON usageHistory(requestId) WHERE requestId IS NOT NULL;
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO _meta(key, value) VALUES ('schemaVersion', '7');
  `);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, NULL, 1, ?)`,
    ["key-packed", packApiKeyRecord(RAW_KEY), "Packed", "2026-08-20T00:00:00.000Z"]
  );
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, NULL, 1, ?)`,
    ["key-legacy", LEGACY_KEY, "Legacy", "2026-08-20T00:00:00.000Z"]
  );

  const rows = [
    [3, RAW_KEY, "req-packed", 2, 3, 0.25],
    [7, LEGACY_KEY, "req-legacy", 5, 8, 0.5],
    [11, "local-no-key", "req-local", 13, 21, 0.75],
    [19, UNKNOWN_KEY, "req-unmatched", 34, 55, 1.25],
  ];
  for (const [id, apiKey, requestId, prompt, completion, cost] of rows) {
    db.run(
      `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId)
       VALUES (?, '2026-08-21T12:00:00.000Z', 'openai', 'gpt-5', 'conn-1', ?, '/v1/chat/completions', ?, ?, ?, 'ok', ?, '{}', ?)`,
      [id, apiKey, prompt, completion, cost, JSON.stringify({ prompt_tokens: prompt, completion_tokens: completion }), requestId]
    );
  }
  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES (?, ?)`, [
    "2026-08-21",
    JSON.stringify({
      requests: 4,
      tokens: { prompt_tokens: 54, completion_tokens: 87 },
      cost: 2.75,
      byProvider: { openai: { requests: 4, cost: 2.75 } },
      byModel: { "gpt-5": { requests: 4, cost: 2.75 } },
      byEndpoint: { "/v1/chat/completions": { requests: 4 } },
      byApiKey: {
        [`${RAW_KEY}|gpt-5|openai`]: { apiKey: RAW_KEY, rawModel: "gpt-5", provider: "openai", requests: 1, cost: 0.25 },
        [`${LEGACY_KEY}|gpt-5|openai`]: { apiKey: LEGACY_KEY, rawModel: "gpt-5", provider: "openai", requests: 1, cost: 0.5 },
        ["local-no-key|gpt-5|openai"]: { apiKey: "local-no-key", rawModel: "gpt-5", provider: "openai", requests: 1, cost: 0.75 },
        [`${UNKNOWN_KEY}|gpt-5|openai`]: { apiKey: UNKNOWN_KEY, rawModel: "gpt-5", provider: "openai", requests: 1, cost: 1.25 },
      },
    }),
  ]);
  return { db, file };
}

function snapshot(db) {
  const row = db.get(`SELECT COUNT(*) count, SUM(promptTokens) prompt, SUM(completionTokens) completion, SUM(cost) cost, MAX(id) maxId FROM usageHistory`);
  return { ...row, requestIds: db.all(`SELECT requestId FROM usageHistory ORDER BY id`).map((entry) => entry.requestId) };
}

describe("migration 8 client key identity scrub", () => {
  it("maps known usage to stable IDs and preserves all non-secret usage", async () => {
    const { db } = await createVersion7Fixture();
    const before = snapshot(db);
    const beforeDaily = JSON.parse(db.get(`SELECT data FROM usageDaily`).data);

    db.transaction(() => migration.up(db));

    const columns = db.all(`PRAGMA table_info(usageHistory)`).map((column) => column.name);
    expect(columns).toContain("clientKeyId");
    expect(columns).not.toContain("apiKey");
    expect(db.all(`SELECT id, clientKeyId FROM usageHistory ORDER BY id`)).toEqual([
      { id: 3, clientKeyId: "key-packed" },
      { id: 7, clientKeyId: "key-legacy" },
      { id: 11, clientKeyId: null },
      { id: 19, clientKeyId: null },
    ]);
    expect(db.all(`SELECT id, spentUsd FROM apiKeys ORDER BY id`)).toEqual([
      { id: "key-legacy", spentUsd: 0.5 },
      { id: "key-packed", spentUsd: 0.25 },
    ]);
    expect(snapshot(db)).toEqual(before);

    const daily = JSON.parse(db.get(`SELECT data FROM usageDaily`).data);
    expect(daily.byApiKey).toBeUndefined();
    expect(daily.byClientKey).toEqual({
      "key-packed|gpt-5|openai": { clientKeyId: "key-packed", rawModel: "gpt-5", provider: "openai", requests: 1, cost: 0.25 },
      "key-legacy|gpt-5|openai": { clientKeyId: "key-legacy", rawModel: "gpt-5", provider: "openai", requests: 1, cost: 0.5 },
      "local-no-key|gpt-5|openai": { clientKeyId: null, rawModel: "gpt-5", provider: "openai", requests: 2, cost: 2 },
    });
    for (const key of ["requests", "tokens", "cost", "byProvider", "byModel", "byEndpoint"]) {
      expect(daily[key]).toEqual(beforeDaily[key]);
    }
    expect(JSON.stringify(daily)).not.toContain(RAW_KEY);
    expect(JSON.stringify(daily)).not.toContain(LEGACY_KEY);
    expect(JSON.stringify(daily)).not.toContain(UNKNOWN_KEY);

    expect(db.all(`PRAGMA index_list(usageHistory)`).map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_uh_ts", "idx_uh_provider", "idx_uh_model", "idx_uh_conn", "idx_uh_client_key", "idx_uh_request_id",
    ]));
    expect(() => db.run(`INSERT INTO usageHistory(timestamp, requestId) VALUES ('2026-08-22T00:00:00.000Z', 'req-packed')`)).toThrow();
    db.run(`INSERT INTO usageHistory(timestamp) VALUES ('2026-08-22T00:00:00.000Z')`);
    expect(db.get(`SELECT MAX(id) id FROM usageHistory`).id).toBeGreaterThan(before.maxId);
    db.close();
  });

  it("leaves schemaVersion at 7 when afterUp fails and safely retries", async () => {
    const { db } = await createVersion7Fixture();
    const m008 = MIGRATIONS.find((entry) => entry.version === 8);
    const originalAfterUp = m008.afterUp;
    m008.afterUp = () => {
      throw new Error("vacuum failed");
    };

    expect(() => runVersionedMigrations(db)).toThrow("vacuum failed");
    expect(db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value).toBe("7");
    expect(db.all(`PRAGMA table_info(usageHistory)`).map((column) => column.name)).toContain("clientKeyId");

    m008.afterUp = originalAfterUp;
    expect(runVersionedMigrations(db)).toEqual({ applied: 1, from: 7, to: 8 });
    expect(db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value).toBe("8");
    db.close();
  });

  it("retries a failed afterUp through runMigrationOnce on the same adapter", async () => {
    const { db } = await createVersion7Fixture();
    const m008 = MIGRATIONS.find((entry) => entry.version === 8);
    const originalAfterUp = m008.afterUp;
    m008.afterUp = () => { throw new Error("vacuum failed once"); };
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    await expect(runMigrationOnce(db)).rejects.toThrow("vacuum failed once");
    m008.afterUp = originalAfterUp;
    await expect(runMigrationOnce(db)).resolves.toBeUndefined();
    expect(db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value).toBe("8");
    db.close();
  });

  it("is idempotent and round-trips without reconstructing gateway secrets", async () => {
    const { db, file } = await createVersion7Fixture();
    const before = snapshot(db);

    db.transaction(() => migration.up(db));
    const once = snapshot(db);
    db.transaction(() => migration.up(db));
    expect(snapshot(db)).toEqual(once);

    db.transaction(() => migration.down(db));
    expect(db.all(`PRAGMA table_info(usageHistory)`).map((column) => column.name)).toContain("apiKey");
    expect(db.all(`SELECT DISTINCT apiKey FROM usageHistory`)).toEqual([{ apiKey: null }]);
    expect(db.all(`SELECT key FROM apiKeys`).every(({ key }) => key.startsWith("v2:"))).toBe(true);
    expect(snapshot(db)).toEqual(before);
    const downDaily = JSON.parse(db.get(`SELECT data FROM usageDaily`).data);
    expect(downDaily.byClientKey).toBeUndefined();
    expect(JSON.stringify(downDaily)).not.toContain(RAW_KEY);

    db.transaction(() => migration.up(db));
    migration.afterUp(db);
    expect(snapshot(db)).toEqual(before);
    db.close();

    const bytes = [file, `${file}-wal`]
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => fs.readFileSync(candidate))
      .reduce((all, chunk) => Buffer.concat([all, chunk]), Buffer.alloc(0));
    for (const secret of [RAW_KEY, LEGACY_KEY, UNKNOWN_KEY]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  });
});
