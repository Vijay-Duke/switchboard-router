// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    expect(latestVersion()).toBe(9);
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
      "prometheusMetricState", "prometheusUsageTotals", "prometheusRoutingRequests", "prometheusRoutingTotals",
    ]));
  }, 15_000);

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("checkpoints WAL before creating an app-upgrade backup", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`UPDATE _meta SET value = '0.0.1' WHERE key = 'appVersion'`);

    const events = [];
    const originalCheckpoint = db.checkpoint;
    db.checkpoint = vi.fn(() => {
      events.push("checkpoint");
      originalCheckpoint?.();
    });
    const originalCopyFileSync = fs.copyFileSync;
    const copyFileSync = vi.spyOn(fs, "copyFileSync").mockImplementation((...args) => {
      events.push("backup");
      return originalCopyFileSync(...args);
    });

    // A fresh migration module gives this adapter a new once-only migration scope,
    // matching a process restart while keeping the real adapter and WAL available.
    vi.resetModules();
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    await runMigrationOnce(db);

    expect(db.checkpoint).toHaveBeenCalledOnce();
    expect(copyFileSync).toHaveBeenCalledOnce();
    expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("backup"));
    copyFileSync.mockRestore();
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      providerConnections: [{
        id: "legacy-connection",
        provider: "legacy",
        authType: "oauth",
        accessToken: "legacy-access-token",
      }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));
    fs.writeFileSync(path.join(tempDir, "usage.json"), JSON.stringify({
      history: [{ apiKey: "abc", provider: "openai", model: "gpt-5", cost: 1 }],
      dailySummary: {
        "2026-08-21": {
          requests: 1,
          promptTokens: 10,
          completionTokens: 4,
          cachedTokens: 2,
          cost: 1,
          byProvider: {
            openai: { requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 2, cost: 1 },
          },
          byApiKey: { "abc|gpt-5|openai": { apiKey: "abc", rawModel: "gpt-5", provider: "openai", cost: 1 } },
        },
      },
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toMatch(/^v1:/);
    expect(keys[0].spentUsd).toBe(1);
    expect(keys[0].lookupDigest).toBeNull();
    expect(db.get(`SELECT value FROM _meta WHERE key = 'migratedAt'`)?.value).toBeTruthy();
    expect(fs.existsSync(path.join(tempDir, "db", ".migrated-from-json"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"))).toBe(true);

    const connection = db.get(`SELECT data FROM providerConnections WHERE id = ?`, ["legacy-connection"]);
    expect(connection.data).not.toContain("legacy-access-token");

    const { getUsageMetricTotals } = await import("@/lib/db/repos/usageRepo.js");
    expect(await getUsageMetricTotals()).toEqual({
      byProvider: [
        { provider: "openai", requests: 1, promptTokens: 10, completionTokens: 4, cachedTokens: 2, cost: 1 },
      ],
    });

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);

    for (const file of [path.join(tempDir, "db.json"), path.join(tempDir, "usage.json")]) {
      expect(fs.readFileSync(file, "utf8")).not.toContain("\"abc\"");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const backupRoot = path.join(tempDir, "db", "backups");
    const backupBytes = fs.readdirSync(backupRoot)
      .flatMap((dir) => fs.readdirSync(path.join(backupRoot, dir)).map((name) => fs.readFileSync(path.join(backupRoot, dir, name), "utf8")))
      .join("\\n");
    expect(backupBytes).not.toContain("\"abc\"");

    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy), { mode: 0o600 });
    const oldMigrationBackup = fs.readdirSync(backupRoot).find((name) => name.startsWith("migrate-from-json-"));
    fs.writeFileSync(path.join(backupRoot, oldMigrationBackup, "db.json"), JSON.stringify(legacy), { mode: 0o600 });
    fs.rmSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"), { force: true });
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: firstRestartAdapter } = await import("@/lib/db/driver.js");
    const firstRestart = await firstRestartAdapter();
    expect(fs.readFileSync(path.join(tempDir, "db.json"), "utf8")).not.toContain("\"abc\"");
    expect(fs.readFileSync(path.join(backupRoot, oldMigrationBackup, "db.json"), "utf8")).not.toContain("\"abc\"");
    expect(fs.existsSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"))).toBe(true);

    const sanitizedPaths = [
      path.join(tempDir, "db.json"),
      path.join(tempDir, "usage.json"),
      path.join(backupRoot, oldMigrationBackup, "db.json"),
      path.join(backupRoot, oldMigrationBackup, "usage.json"),
    ];
    const sanitized = new Map(sanitizedPaths.map((file) => [file, {
      bytes: fs.readFileSync(file),
      mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
    }]));

    firstRestart.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: secondRestartAdapter } = await import("@/lib/db/driver.js");
    await secondRestartAdapter();

    for (const file of sanitizedPaths) {
      expect(fs.readFileSync(file)).toEqual(sanitized.get(file).bytes);
      expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(sanitized.get(file).mtimeNs);
    }
  }, 15_000);

  it("keeps originals and migration backups intact when a row import fails and the transaction rolls back", async () => {
    const mainPath = path.join(tempDir, "db.json");
    const usagePath = path.join(tempDir, "usage.json");
    const mainBytes = JSON.stringify({
      settings: { mustRollback: true },
      apiKeys: [
        { id: "duplicate", key: "legacy-one", createdAt: "2026-08-20T00:00:00.000Z" },
        { id: "duplicate", key: "legacy-two", createdAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    const usageBytes = JSON.stringify({ history: [{ apiKey: "legacy-one", cost: 4 }] });
    fs.writeFileSync(mainPath, mainBytes);
    fs.writeFileSync(usagePath, usageBytes);

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(db.get(`SELECT COUNT(*) count FROM apiKeys`).count).toBe(0);
    expect(db.get(`SELECT COUNT(*) count FROM settings`).count).toBe(0);
    expect(db.get(`SELECT value FROM _meta WHERE key = 'migratedAt'`)).toBeUndefined();
    expect(fs.readFileSync(mainPath, "utf8")).toBe(mainBytes);
    expect(fs.readFileSync(usagePath, "utf8")).toBe(usageBytes);
    expect(fs.existsSync(path.join(tempDir, "db", ".migrated-from-json"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"))).toBe(false);

    const backupRoot = path.join(tempDir, "db", "backups");
    const migrationBackup = fs.readdirSync(backupRoot).find((name) => name.startsWith("migrate-from-json-"));
    expect(fs.readFileSync(path.join(backupRoot, migrationBackup, "db.json"), "utf8")).toBe(mainBytes);
    expect(fs.readFileSync(path.join(backupRoot, migrationBackup, "usage.json"), "utf8")).toBe(usageBytes);

    fs.writeFileSync(mainPath, JSON.stringify({
      settings: { repaired: true },
      apiKeys: [{ id: "repaired", key: "legacy-one", createdAt: "2026-08-20T00:00:00.000Z" }],
    }));
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: repairedAdapter } = await import("@/lib/db/driver.js");
    const repaired = await repairedAdapter();
    expect(repaired.get(`SELECT COUNT(*) count FROM apiKeys`).count).toBe(1);
    expect(repaired.get(`SELECT COUNT(*) count FROM usageHistory`).count).toBe(1);
    expect(repaired.get(`SELECT spentUsd FROM apiKeys WHERE id = 'repaired'`).spentUsd).toBe(4);
    expect(repaired.get(`SELECT value FROM _meta WHERE key = 'migratedAt'`)?.value).toBeTruthy();
    expect(fs.readFileSync(path.join(backupRoot, migrationBackup, "db.json"), "utf8")).not.toContain("legacy-one");
    expect(fs.readFileSync(path.join(backupRoot, migrationBackup, "usage.json"), "utf8")).not.toContain("legacy-one");
    expect(fs.readFileSync(mainPath, "utf8")).not.toContain("legacy-one");
  });

  it("does not sanitize originals or old backups from a schema-stamped crash without durable import proof", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`)?.value).toBe("9");
    db.run(`INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'partial', '"keep"')`);
    db.close?.();

    const mainBytes = JSON.stringify({ apiKeys: [{ id: "unproved", key: "raw-unproved-secret" }] });
    const usageBytes = JSON.stringify({ history: [{ apiKey: "raw-unproved-secret" }] });
    fs.writeFileSync(path.join(tempDir, "db.json"), mainBytes);
    fs.writeFileSync(path.join(tempDir, "usage.json"), usageBytes);
    const backupDir = path.join(tempDir, "db", "backups", "migrate-from-json-crashed");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "db.json"), mainBytes);

    fs.writeFileSync(path.join(backupDir, "usage.json"), usageBytes);

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: restartAdapter } = await import("@/lib/db/driver.js");
    const restarted = await restartAdapter();

    expect(restarted.get(`SELECT value FROM _meta WHERE key = 'migratedAt'`)).toBeUndefined();
    expect(fs.readFileSync(path.join(tempDir, "db.json"), "utf8")).toBe(mainBytes);
    expect(fs.readFileSync(path.join(tempDir, "usage.json"), "utf8")).toBe(usageBytes);
    expect(restarted.get(`SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'partial'`)?.value).toBe('"keep"');
    expect(fs.readFileSync(path.join(backupDir, "db.json"), "utf8")).toBe(mainBytes);
    expect(fs.readFileSync(path.join(backupDir, "usage.json"), "utf8")).toBe(usageBytes);
    expect(fs.existsSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"))).toBe(false);
  });
  it("imports packed-key legacy usage without verifier KDF work per history row", async () => {
    const raw = "sk-legacy-large";
    const { matchesApiKeyRecord, packApiKeyRecord } = await import("@/lib/crypto/secrets.js");
    const packed = packApiKeyRecord(raw);
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify({
      apiKeys: [{ id: "large-key", key: packed, createdAt: "2026-08-20T00:00:00.000Z" }],
    }));
    fs.writeFileSync(path.join(tempDir, "usage.json"), JSON.stringify({
      history: Array.from({ length: 250 }, (_, index) => ({
        apiKey: raw, provider: "openai", model: "gpt-5", cost: 1,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      })),
    }));
    const verifierResolution = vi.fn(matchesApiKeyRecord);
    const migrationModule = await import("@/lib/db/migrate.js");
    migrationModule.__setLegacyKeyMatcherForTests(verifierResolution);
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.get(`SELECT COUNT(*) count FROM usageHistory`).count).toBe(250);
    expect(db.get(`SELECT DISTINCT clientKeyId FROM usageHistory`)).toEqual({ clientKeyId: "large-key" });
    expect(db.get(`SELECT spentUsd FROM apiKeys WHERE id = 'large-key'`).spentUsd).toBe(250);
    expect(verifierResolution).toHaveBeenCalledOnce();
    migrationModule.__setLegacyKeyMatcherForTests();
  }, 15_000);

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
