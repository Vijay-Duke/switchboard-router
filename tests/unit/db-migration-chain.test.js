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
    expect(latestVersion()).toBe(8);
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
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
    expect(keys[0].key).toMatch(/^v2:/);
    expect(keys[0].spentUsd).toBe(1);

    const connection = db.get(`SELECT data FROM providerConnections WHERE id = ?`, ["legacy-connection"]);
    expect(connection.data).not.toContain("legacy-access-token");

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
    fs.rmSync(path.join(tempDir, "db", ".legacy-secrets-sanitized"), { force: true });
    db.close?.();
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: restartAdapter } = await import("@/lib/db/driver.js");
    await restartAdapter();
    expect(fs.readFileSync(path.join(tempDir, "db.json"), "utf8")).not.toContain("\"abc\"");
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
