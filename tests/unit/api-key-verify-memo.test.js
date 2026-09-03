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
  file = path.join(os.tmpdir(), `switchboard-api-key-verify-memo-${crypto.randomUUID()}.sqlite`);
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
  repo.__resetApiKeyVerifyMemoForTests();
  vi.useRealTimers();
});

afterAll(() => {
  db?.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
});

describe("api key verify memo (P3)", () => {
  it("runs scrypt once for two authentications of the same v2 key", async () => {
    const created = await repo.createApiKey("Memo", "0123456789abcdef");
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    try {
      const first = await repo.authenticateApiKey(created.key);
      const second = await repo.authenticateApiKey(created.key);
      expect(first?.id).toBe(created.id);
      expect(second?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledOnce();
    } finally {
      scrypt.mockRestore();
    }
  });

  it("runs scrypt for a wrong key with the same keyId, returns null, and keeps the correct memo", async () => {
    const created = await repo.createApiKey("MemoWrong", "0123456789abcdef");
    const parts = created.key.split("-");
    const wrong = `${parts[0]}-${parts[1]}-${parts[2]}-deadbeef`;
    expect(wrong).not.toBe(created.key);
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    try {
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledOnce();
      // Same lookupDigest (same keyId), different raw: KDF runs, auth fails.
      expect(await repo.authenticateApiKey(wrong)).toBeNull();
      expect(scrypt).toHaveBeenCalledTimes(2);
      // The failed attempt must not clobber the correct entry: still no KDF.
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledTimes(2);
    } finally {
      scrypt.mockRestore();
    }
  });

  it("runs scrypt again after updateApiKey invalidates the memo", async () => {
    const created = await repo.createApiKey("MemoUpdate", "0123456789abcdef");
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    try {
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledOnce();
      await repo.updateApiKey(created.id, { name: "Renamed" });
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledTimes(2);
    } finally {
      scrypt.mockRestore();
    }
  });

  it("runs scrypt again after the memo TTL expires", async () => {
    const created = await repo.createApiKey("MemoTtl", "0123456789abcdef");
    const scrypt = vi.spyOn(nodeCrypto, "scrypt");
    try {
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledOnce();
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 61_000);
      expect((await repo.authenticateApiKey(created.key))?.id).toBe(created.id);
      expect(scrypt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      scrypt.mockRestore();
    }
  });
});
