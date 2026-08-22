import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function expectSafe(record) {
  expect(record).not.toHaveProperty("key");
  expect(record).toEqual(expect.objectContaining({
    id: expect.any(String),
    keyPrefix: expect.any(String),
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
    const created = await repo.createApiKey("Automation", "machine-1");
    expect(created.key).toMatch(/^sk-/);
    expect(created.allowedModels).toEqual([]);
    expect(created.allowedCombos).toEqual([]);
    expect(created.spentUsd).toBe(0);

    const [listed] = await repo.getApiKeys();
    const detail = await repo.getApiKeyById(created.id);
    const authenticated = await repo.authenticateApiKey(created.key);
    expectSafe(listed);
    expectSafe(detail);
    expectSafe(authenticated);
    expect(authenticated.id).toBe(created.id);
  });

  it("authenticates and upgrades legacy plaintext but rejects inactive keys", async () => {
    db.run(
      `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES ('legacy', 'legacy-raw-key', 'Legacy', 1, '2026-08-22T00:00:00.000Z')`
    );
    expect((await repo.authenticateApiKey("legacy-raw-key")).id).toBe("legacy");
    expect(db.get(`SELECT key FROM apiKeys WHERE id = 'legacy'`).key).toMatch(/^v1:/);

    await repo.updateApiKey("legacy", { isActive: false });
    expect(await repo.authenticateApiKey("legacy-raw-key")).toBeNull();
    expect(await repo.validateApiKey("legacy-raw-key")).toBe(false);
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
    }
    expect(await repo.getClientKeySpend(first.id)).toBe(3.75);
    expect((await repo.getApiKeyById(first.id)).spentUsd).toBe(3.75);
    expect((await repo.authenticateApiKey(first.key)).spentUsd).toBe(3.75);
  });
});
