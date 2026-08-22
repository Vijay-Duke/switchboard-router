import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));

let db;
let file;
let repo;

beforeAll(async () => {
  file = path.join(os.tmpdir(), `switchboard-client-key-repo-${crypto.randomUUID()}.sqlite`);
  db = await createNodeSqliteAdapter(file);
  for (const table of ["apiKeys", "usageHistory"]) {
    db.exec(buildCreateTableSql(table, TABLES[table]));
    for (const index of TABLES[table].indexes || []) db.exec(index);
  }
  mocks.getAdapter.mockResolvedValue(db);
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
});

beforeEach(() => {
  db.run(`DELETE FROM usageHistory`);
  db.run(`DELETE FROM apiKeys`);
});

afterAll(() => {
  db?.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
});

function expectSafe(record, rotationRequired = false) {
  expect(record).not.toHaveProperty("key");
  expect(record).not.toHaveProperty("lookupDigest");
  expect(record).toEqual(expect.objectContaining({
    id: expect.any(String),
    keyPrefix: expect.any(String),
    rotationRequired,
    allowedModels: expect.any(Array),
    allowedCombos: expect.any(Array),
    expiresAt: null,
    rateLimitPerMinute: null,
    concurrencyLimit: null,
    spendLimitUsd: null,
    spentUsd: expect.any(Number),
  }));
}

describe("client key repository", () => {
  it("returns the generated secret once and only safe records afterward", async () => {
    const created = await repo.createApiKey("Automation", "0123456789abcdef");
    expect(created.key).toMatch(/^sk-/);
    expect(created.allowedModels).toEqual([]);
    expect(created.allowedCombos).toEqual([]);
    const stored = db.get(`SELECT key, lookupDigest FROM apiKeys WHERE id = ?`, [created.id]);
    const { apiKeyLookupDigest } = await import("@/lib/crypto/secrets.js");
    const rawKeyId = created.key.split("-").at(-2);
    expect(stored.key).toMatch(/^v2:/);
    expect(stored.lookupDigest).toBe(apiKeyLookupDigest(created.key));
    expect(stored.lookupDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(rawKeyId);
    expect(created.spentUsd).toBe(0);

    const [listed] = await repo.getApiKeys();
    const detail = await repo.getApiKeyById(created.id);
    const authenticated = await repo.authenticateApiKey(created.key);
    expectSafe(listed);
    expectSafe(detail);
    expectSafe(authenticated);
    expect(authenticated.id).toBe(created.id);
  });

  it("keeps unparseable legacy keys usable and rotation-required without v2 fanout", async () => {
    const raw = "sk-legacyraw";
    const { apiKeyPrefix, hashApiKey } = await import("@/lib/crypto/secrets.js");
    const prefix = apiKeyPrefix(raw);
    db.run(
      `INSERT INTO apiKeys(id, key, keyPrefix, name, isActive, createdAt)
       VALUES ('legacy', ?, ?, 'Legacy', 1, '2026-08-22T00:00:00.000Z')`,
      [raw, prefix],
    );

    expectSafe(await repo.authenticateApiKey(raw), true);
    expectSafe(await repo.getApiKeyById("legacy"), true);
    const plaintextUpgrade = db.get(`SELECT key, lookupDigest FROM apiKeys WHERE id = 'legacy'`);
    expect(plaintextUpgrade.key).toMatch(/^v1:/);
    expect(plaintextUpgrade.key).not.toContain(raw);
    expect(plaintextUpgrade.lookupDigest).toBeNull();

    db.run(`UPDATE apiKeys SET key = ? WHERE id = 'legacy'`, [`v1:${prefix}:${hashApiKey(raw)}`]);
    expectSafe(await repo.authenticateApiKey(raw), true);
    expect(db.get(`SELECT key, lookupDigest FROM apiKeys WHERE id = 'legacy'`)).toEqual({
      key: `v1:${prefix}:${hashApiKey(raw)}`,
      lookupDigest: null,
    });
    expect(await repo.validateApiKey(raw)).toBe(true);

    await repo.updateApiKey("legacy", { isActive: false });
    expect(await repo.authenticateApiKey(raw)).toBeNull();
  });

  it("verifies only matching-prefix legacy rows when many unrelated rows exist", async () => {
    const raw = "sk-legacy-prefix-target";
    const { apiKeyPrefix, hashApiKey } = await import("@/lib/crypto/secrets.js");
    const prefix = apiKeyPrefix(raw);
    const hash = hashApiKey(raw);
    for (let index = 0; index < 64; index += 1) {
      db.run(
        `INSERT INTO apiKeys(id, key, keyPrefix, name, isActive, createdAt)
         VALUES (?, ?, ?, ?, 1, '2026-08-22T00:00:00.000Z')`,
        [`unrelated-${index}`, `v1:other-${index}…:${hash}`, `other-${index}…`, `Unrelated ${index}`],
      );
    }
    db.run(
      `INSERT INTO apiKeys(id, key, keyPrefix, name, isActive, createdAt)
       VALUES ('legacy-match', ?, ?, 'Legacy match', 1, '2026-08-22T00:00:00.000Z')`,
      [`v1:${prefix}:${hash}`, prefix],
    );
    const allSpy = vi.spyOn(db, "all");

    const authenticated = await repo.authenticateApiKey(raw);

    expectSafe(authenticated, true);
    expect(authenticated.id).toBe("legacy-match");
    const fallbackQueries = allSpy.mock.calls.filter(([sql]) => String(sql).includes("lookupDigest IS NULL"));
    expect(fallbackQueries).toHaveLength(1);
    expect(fallbackQueries[0][0]).toContain("k.keyPrefix = ?");
    expect(fallbackQueries[0][1]).toEqual([prefix]);
    allSpy.mockRestore();
  });
  
  it("upgrades parseable plaintext and v1 modern keys to indexed v2 digests", async () => {
    const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey.js");
    const { apiKeyLookupDigest, apiKeyPrefix, hashApiKey } = await import("@/lib/crypto/secrets.js");
    const plaintext = generateApiKeyWithMachine("1111111111111111").key;
    const v1 = generateApiKeyWithMachine("2222222222222222").key;
    db.run(
      `INSERT INTO apiKeys(id, key, keyPrefix, name, isActive, createdAt)
       VALUES ('plain-modern', ?, ?, 'Plain', 1, '2026-08-22T00:00:00.000Z')`,
      [plaintext, apiKeyPrefix(plaintext)],
    );
    db.run(
      `INSERT INTO apiKeys(id, key, keyPrefix, name, isActive, createdAt)
       VALUES ('v1-modern', ?, ?, 'V1', 1, '2026-08-22T00:00:00.000Z')`,
      [`v1:${apiKeyPrefix(v1)}:${hashApiKey(v1)}`, apiKeyPrefix(v1)],
    );

    for (const [id, raw] of [["plain-modern", plaintext], ["v1-modern", v1]]) {
      expectSafe(await repo.authenticateApiKey(raw));
      const stored = db.get(`SELECT key, lookupDigest FROM apiKeys WHERE id = ?`, [id]);
      expect(stored.key).toMatch(/^v2:/);
      expect(stored.lookupDigest).toBe(apiKeyLookupDigest(raw));
      expect(JSON.stringify(stored)).not.toContain(raw.split("-").at(-2));
    }
  });

  it("normalizes policy arrays, updates atomically, and clears explicit fields", async () => {
    const created = await repo.createApiKey("Policy", "machine-2");
    const updated = await repo.updateApiKey(created.id, {
      name: "Renamed",
      allowedModels: [" gpt-5 ", "gpt-5", "claude/sonnet"],
      allowedCombos: [" fast ", "fast"],
      expiresAt: "2026-09-01T12:30:00.000Z",
      rateLimitPerMinute: 42,
      concurrencyLimit: 3,
      spendLimitUsd: 12.5,
    });
    expect(updated).toEqual(expect.objectContaining({
      name: "Renamed",
      allowedModels: ["gpt-5", "claude/sonnet"],
      allowedCombos: ["fast"],
      expiresAt: "2026-09-01T12:30:00.000Z",
      rateLimitPerMinute: 42,
      concurrencyLimit: 3,
      spendLimitUsd: 12.5,
    }));

    const cleared = await repo.updateApiKey(created.id, {
      allowedModels: null,
      allowedCombos: [],
      expiresAt: "",
      rateLimitPerMinute: null,
      concurrencyLimit: null,
      spendLimitUsd: null,
    });
    expect(cleared).toEqual(expect.objectContaining({
      allowedModels: [], allowedCombos: [], expiresAt: null,
      rateLimitPerMinute: null, concurrencyLimit: null, spendLimitUsd: null,
    }));
  });

  it("rejects unknown fields and every policy bound", () => {
    const { CLIENT_KEY_POLICY_BOUNDS: bounds, normalizeClientKeyPatch: normalize } = repo;
    expect(() => normalize({ key: "secret" })).toThrow(/unknown/i);
    expect(() => normalize({ machineId: "other" })).toThrow(/unknown/i);
    expect(() => normalize({ allowedModels: "gpt-5" })).toThrow(/array/i);
    expect(() => normalize({ allowedModels: Array.from({ length: bounds.maxAllowlistEntries + 1 }, (_, i) => `m${i}`) })).toThrow(/at most/i);
    expect(() => normalize({ allowedCombos: ["x".repeat(bounds.maxTargetLength + 1)] })).toThrow(/length/i);
    expect(() => normalize({ allowedModels: ["  "] })).toThrow(/empty/i);
    expect(() => normalize({ expiresAt: "tomorrow" })).toThrow(/ISO/i);
    expect(() => normalize({ rateLimitPerMinute: 0 })).toThrow(/rateLimitPerMinute/i);
    expect(() => normalize({ rateLimitPerMinute: bounds.maxRatePerMinute + 1 })).toThrow(/rateLimitPerMinute/i);
    expect(() => normalize({ rateLimitPerMinute: 1.5 })).toThrow(/rateLimitPerMinute/i);
    expect(() => normalize({ concurrencyLimit: 0 })).toThrow(/concurrencyLimit/i);
    expect(() => normalize({ concurrencyLimit: bounds.maxConcurrency + 1 })).toThrow(/concurrencyLimit/i);
    expect(() => normalize({ spendLimitUsd: -1 })).toThrow(/spendLimitUsd/i);
    expect(() => normalize({ spendLimitUsd: bounds.maxSpendUsd + 1 })).toThrow(/spendLimitUsd/i);
    expect(() => normalize({ spendLimitUsd: Number.POSITIVE_INFINITY })).toThrow(/spendLimitUsd/i);

    expect(normalize({
      allowedModels: ["gpt-5"],
      expiresAt: "2026-08-21T00:00:00Z",
      rateLimitPerMinute: 1,
      concurrencyLimit: 1,
      spendLimitUsd: 0,
    })).toEqual({
      allowedModels: ["gpt-5"],
      expiresAt: "2026-08-21T00:00:00.000Z",
      rateLimitPerMinute: 1,
      concurrencyLimit: 1,
      spendLimitUsd: 0,
    });
  });

  it("attributes persisted spend by stable client key ID", async () => {
    const first = await repo.createApiKey("First", "machine-3");
    const second = await repo.createApiKey("Second", "machine-4");
    for (const [clientKeyId, cost] of [[first.id, 1.25], [first.id, 2.5], [second.id, 9], [null, 50]]) {
      db.run(
        `INSERT INTO usageHistory(timestamp, clientKeyId, cost) VALUES ('2026-08-22T00:00:00.000Z', ?, ?)`,
        [clientKeyId, cost]
      );
      if (clientKeyId) db.run(`UPDATE apiKeys SET spentUsd = spentUsd + ? WHERE id = ?`, [cost, clientKeyId]);
    }
    expect(await repo.getClientKeySpend(first.id)).toBe(3.75);
    expect((await repo.getApiKeyById(first.id)).spentUsd).toBe(3.75);
    expect((await repo.authenticateApiKey(first.key)).spentUsd).toBe(3.75);
  });

  it("reads durable spend for only the matched key and survives history pruning", async () => {
    const first = await repo.createApiKey("First", "machine-ledger-1");
    await repo.createApiKey("Second", "machine-ledger-2");
    db.run(`UPDATE apiKeys SET spentUsd = 17.5 WHERE id = ?`, [first.id]);
    db.run(`DELETE FROM usageHistory`);
    const getSpy = vi.spyOn(db, "get");
    expect((await repo.authenticateApiKey(first.key)).spentUsd).toBe(17.5);
    const spendQueries = getSpy.mock.calls.filter(([sql]) => String(sql).includes("spentUsd"));
    expect(spendQueries).toHaveLength(1);
    expect(spendQueries[0][1]).toEqual([first.id]);
    getSpy.mockRestore();
  });

  it("authenticates more than eight same-machine modern keys by one digest lookup and one async KDF", async () => {
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      created.push(await repo.createApiKey(`Key ${index}`, "3333333333333333"));
    }
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    const getSpy = vi.spyOn(db, "get");

    for (const selected of [created[0], created[8], created[11]]) {
      scrypt.mockClear();
      getSpy.mockClear();
      expect((await repo.authenticateApiKey(selected.key)).id).toBe(selected.id);
      expect(scrypt).toHaveBeenCalledOnce();
      const lookupCalls = getSpy.mock.calls.filter(([sql]) => String(sql).includes("lookupDigest = ?"));
      expect(lookupCalls).toHaveLength(1);
      expect(lookupCalls[0][1]).toEqual([(await import("@/lib/crypto/secrets.js")).apiKeyLookupDigest(selected.key)]);
    }

    scrypt.mockRestore();
    getSpy.mockRestore();
  });

  it("performs zero KDFs for an unknown valid modern key and never scans lookup-less v2 rows", async () => {
    await repo.createApiKey("Bounded", "4444444444444444");
    const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey.js");
    const unknown = generateApiKeyWithMachine("4444444444444444").key;
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    const allSpy = vi.spyOn(db, "all");
    const getSpy = vi.spyOn(db, "get");

    expect(await repo.authenticateApiKey(unknown)).toBeNull();
    expect(scrypt).not.toHaveBeenCalled();
    expect(getSpy.mock.calls.filter(([sql]) => String(sql).includes("lookupDigest = ?"))).toHaveLength(1);
    expect(allSpy.mock.calls.some(([sql]) => String(sql).includes("key NOT LIKE 'v2:%'"))).toBe(true);
    expect(allSpy.mock.calls.some(([sql]) => String(sql).includes("key LIKE 'v2:%'"))).toBe(false);

    scrypt.mockRestore();
    allSpy.mockRestore();
    getSpy.mockRestore();
  });

  it("marks missing-lookup v2 records for rotation and never authenticates or scans them", async () => {
    const created = await repo.createApiKey("Missing lookup", "8888888888888888");
    const stored = db.get(`SELECT key FROM apiKeys WHERE id = ?`, [created.id]).key.split(":");
    db.run(
      `UPDATE apiKeys SET key = ?, lookupDigest = NULL WHERE id = ?`,
      [`v2:${stored[2]}:${stored[3]}:${stored[4]}`, created.id],
    );
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");

    expectSafe(await repo.getApiKeyById(created.id), true);
    expect(await repo.authenticateApiKey(created.key)).toBeNull();
    expect(scrypt).not.toHaveBeenCalled();

    scrypt.mockRestore();
  });
});
