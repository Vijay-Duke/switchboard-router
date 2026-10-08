import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/db/index.js", async () => ({
  ...await vi.importActual("@/lib/db/repos/connectionsRepo.js"),
  getSettings: vi.fn(async () => ({})),
  getConnectionInFlightCount: vi.fn(() => 0),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
}));
let adapter, directory, file, repo, auth;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-account-status-cas-"));
  file = path.join(directory, "test.sqlite");
  adapter = await createNodeSqliteAdapter(file);
  adapter.exec(buildCreateTableSql("providerConnections", TABLES.providerConnections));
  mocks.getAdapter.mockResolvedValue(adapter);
  repo = await import("@/lib/db/repos/connectionsRepo.js");
  auth = await import("@/sse/services/auth.js");
});
beforeEach(() => {
  mocks.getAdapter.mockReset().mockResolvedValue(adapter);
  adapter.run("DELETE FROM providerConnections");
});
afterAll(() => {
  adapter?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const created = await repo.createProviderConnection({ provider: "claude", authType: "oauth", name: "Test" });
  return repo.updateProviderConnection(created.id, {
    testStatus: "unavailable", lastError: "old error", lastErrorAt: "2026-01-01T00:00:00Z",
    backoffLevel: 2, modelLock_model: "2026-01-01T00:00:00Z",
  });
}
function otherProcessUpdate(id, patch) {
  const code = `
    import { DatabaseSync } from "node:sqlite";
    const [file, id, patch] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT data FROM providerConnections WHERE id = ?").get(id);
    const data = { ...JSON.parse(row.data), ...JSON.parse(patch) };
    db.prepare("UPDATE providerConnections SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, file, id, JSON.stringify(patch)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
function armWriteBeforePersistence(id, patch) {
  mocks.getAdapter.mockResolvedValueOnce(adapter).mockImplementationOnce(async () => {
    otherProcessUpdate(id, patch);
    return adapter;
  });
}
describe("account recovery persistence concurrency", () => {
  it("does not erase a newer 429 written by another process after its fresh read", async () => {
    const selected = await fixture();
    const patch = { testStatus: "unavailable", lastError: "new rate limit", lastErrorAt: new Date().toISOString(), backoffLevel: 3, modelLock_model: new Date(Date.now() + 60_000).toISOString() };
    armWriteBeforePersistence(selected.id, patch);
    await auth.clearAccountError(selected.id, { _connection: selected }, "model");
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(patch);
  });
  it("does not erase a revoked-refresh marker written between read and persistence", async () => {
    const selected = await fixture();
    const patch = { testStatus: "reauth_required", lastError: "reconnect", lastErrorAt: new Date().toISOString() };
    armWriteBeforePersistence(selected.id, patch);
    await auth.clearAccountError(selected.id, { _connection: selected }, "model");
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(patch);
  });
  it("handles a WAL snapshot conflict when another process writes inside the transaction", async () => {
    const selected = await fixture();
    const patch = { testStatus: "reauth_required", lastError: "revoked during transaction", lastErrorAt: new Date().toISOString() };
    const read = adapter.get.bind(adapter);
    const spy = vi.spyOn(adapter, "get").mockImplementationOnce((sql, params) => {
      const row = read(sql, params);
      otherProcessUpdate(selected.id, patch);
      return row;
    });
    try {
      expect(await repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { testStatus: "active", lastError: null })).toBeNull();
    } finally { spy.mockRestore(); }
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(patch);
  });
  it("preserves a credential refresh without treating it as a status conflict", async () => {
    const selected = await fixture();
    otherProcessUpdate(selected.id, { accessToken: "synthetic-test-token", providerSpecificData: { refreshed: true } });
    const result = await repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { testStatus: "active", lastError: null });
    expect(result).toMatchObject({ testStatus: "active", accessToken: "synthetic-test-token", providerSpecificData: { refreshed: true } });
  });
  it("guards an added account-wide lock even if error timestamp and message were reused", async () => {
    const selected = await fixture();
    const accountLock = new Date(Date.now() + 60_000).toISOString();
    otherProcessUpdate(selected.id, { modelLock___all: accountLock });
    expect(await repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { testStatus: "active" })).toBeNull();
    expect((await repo.getProviderConnectionById(selected.id)).modelLock___all).toBe(accountLock);
  });
  it("keeps no-auth success callbacks free of persistence calls", async () => {
    const reads = mocks.getAdapter.mock.calls.length;
    await auth.clearAccountError("noauth", {}, "model");
    expect(mocks.getAdapter.mock.calls).toHaveLength(reads);
  });
  it("cleans expired locks while preserving another model's active lock", async () => {
    const selected = await fixture();
    await repo.updateProviderConnection(selected.id, {
      modelLock_other: new Date(Date.now() + 60_000).toISOString(),
      modelLock_expired: "2026-01-01T00:00:00Z",
    });
    const current = await repo.getProviderConnectionById(selected.id);
    await auth.clearAccountError(selected.id, { _connection: current }, "model");
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject({
      modelLock_model: null, modelLock_expired: null,
      modelLock_other: current.modelLock_other, testStatus: "unavailable", backoffLevel: 2,
    });
  });
  it("rejects changes outside account status rather than replacing credentials", async () => {
    const selected = await fixture();
    await expect(repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { accessToken: "invalid" })).rejects.toThrow("Only account status");
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(selected);
  });
  it("returns null for a deleted account and does not recreate it", async () => {
    const selected = await fixture();
    adapter.run("DELETE FROM providerConnections WHERE id = ?", [selected.id]);
    expect(await repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { testStatus: "active" })).toBeNull();
    expect(await repo.getProviderConnectionById(selected.id)).toBeNull();
  });
  it("supports conditional status updates with the single-process sql.js fallback", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const fallback = await createSqlJsAdapter(path.join(directory, "fallback.sqlite"));
    fallback.exec(buildCreateTableSql("providerConnections", TABLES.providerConnections));
    mocks.getAdapter.mockResolvedValue(fallback);
    try {
      const selected = await fixture();
      await repo.updateProviderConnection(selected.id, { lastError: "new error", backoffLevel: 3 });
      expect(await repo.updateProviderConnectionStatusIfCurrent(selected.id, selected, { testStatus: "active" })).toBeNull();
      const current = await repo.getProviderConnectionById(selected.id);
      expect(await repo.updateProviderConnectionStatusIfCurrent(selected.id, current, { testStatus: "active", lastError: null })).toMatchObject({ testStatus: "active", lastError: null });
    } finally {
      fallback.close();
      mocks.getAdapter.mockResolvedValue(adapter);
    }
  });
});
