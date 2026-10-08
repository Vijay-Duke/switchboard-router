import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
let adapter, directory, file, repo;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-credential-cas-"));
  file = path.join(directory, "test.sqlite");
  adapter = await createNodeSqliteAdapter(file);
  adapter.exec(buildCreateTableSql("providerConnections", TABLES.providerConnections));
  mocks.getAdapter.mockResolvedValue(adapter);
  repo = await import("@/lib/db/repos/connectionsRepo.js");
});
beforeEach(() => adapter.run("DELETE FROM providerConnections"));
afterAll(() => {
  adapter?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture(provider = "claude") {
  return repo.createProviderConnection({
    provider, authType: "oauth", accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    providerSpecificData: { connectionProxyUrl: "old-proxy" },
  });
}
function otherProcessUpdate(id, patch) {
  const code = `
    import { DatabaseSync } from "node:sqlite";
    const [file, id, patch] = process.argv.slice(1);
    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT data FROM providerConnections WHERE id = ?").get(id);
    db.prepare("UPDATE providerConnections SET data = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.data), ...JSON.parse(patch) }), id);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, file, id, JSON.stringify(patch)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
describe("credential rotation persistence concurrency", () => {
  it("does not overwrite a newer token pair saved by another process", async () => {
    const selected = await fixture();
    const fresh = { accessToken: "writer-access", refreshToken: "writer-refresh" };
    otherProcessUpdate(selected.id, fresh);
    expect(await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      accessToken: "late-access", refreshToken: "late-refresh",
    })).toBeNull();
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(fresh);
  });
  it("saves rotated tokens while preserving newly edited connection proxy settings", async () => {
    const selected = await fixture();
    otherProcessUpdate(selected.id, { providerSpecificData: { connectionProxyUrl: "operator-new-proxy" } });
    const result = await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      accessToken: "rotated-access", refreshToken: "rotated-refresh",
      providerSpecificData: { renewedScope: "test-scope" },
    });
    expect(result).toMatchObject({
      accessToken: "rotated-access", refreshToken: "rotated-refresh",
      providerSpecificData: { connectionProxyUrl: "operator-new-proxy", renewedScope: "test-scope" },
    });
  });
  it("preserves a newer Copilot token even when the primary GitHub token did not rotate", async () => {
    let selected = await fixture("github");
    selected = await repo.updateProviderConnection(selected.id, {
      providerSpecificData: { ...selected.providerSpecificData, copilotToken: "old-copilot" },
    });
    otherProcessUpdate(selected.id, { providerSpecificData: { ...selected.providerSpecificData, copilotToken: "writer-copilot" } });
    expect(await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      providerSpecificData: { copilotToken: "late-copilot" },
    })).toBeNull();
    expect((await repo.getProviderConnectionById(selected.id)).providerSpecificData.copilotToken).toBe("writer-copilot");
  });
  it("skips a WAL snapshot conflict if another process rotates tokens during the transaction", async () => {
    const selected = await fixture();
    const fresh = { accessToken: "writer-access", refreshToken: "writer-refresh" };
    const get = adapter.get.bind(adapter);
    const spy = vi.spyOn(adapter, "get").mockImplementationOnce((sql, params) => {
      const row = get(sql, params);
      otherProcessUpdate(selected.id, fresh);
      return row;
    });
    try {
      expect(await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
        accessToken: "late-access", refreshToken: "late-refresh",
      })).toBeNull();
    } finally { spy.mockRestore(); }
    expect(await repo.getProviderConnectionById(selected.id)).toMatchObject(fresh);
  });
  it("rejects health patches instead of clearing concurrent errors during token rotation", async () => {
    const selected = await fixture();
    await expect(repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      testStatus: "active",
    })).rejects.toThrow("credential-only patch");
  });
  it("saves a consumed rotation while preserving an operator disable", async () => {
    const selected = await fixture();
    adapter.run("UPDATE providerConnections SET isActive = 0 WHERE id = ?", [selected.id]);
    const result = await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      accessToken: "rotated-access", refreshToken: "rotated-refresh",
    });
    expect(result).toMatchObject({ isActive: false, accessToken: "rotated-access" });
  });
  it("rejects an OAuth-to-API-key change even if token fields remained unchanged", async () => {
    const selected = await fixture();
    adapter.run("UPDATE providerConnections SET authType = ? WHERE id = ?", ["apikey", selected.id]);
    expect(await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
      accessToken: "late-access", refreshToken: "late-refresh",
    })).toBeNull();
    expect((await repo.getProviderConnectionById(selected.id)).authType).toBe("apikey");
  });
  it("retries a metadata-only WAL conflict without discarding consumed credentials", async () => {
    const selected = await fixture();
    const get = adapter.get.bind(adapter);
    const spy = vi.spyOn(adapter, "get").mockImplementationOnce((sql, params) => {
      const row = get(sql, params);
      otherProcessUpdate(selected.id, { providerSpecificData: { connectionProxyUrl: "operator-new-proxy" } });
      return row;
    });
    try {
      expect(await repo.updateProviderConnectionCredentialsIfCurrent(selected.id, selected, {
        accessToken: "rotated-access", refreshToken: "rotated-refresh",
      })).toMatchObject({
        accessToken: "rotated-access", refreshToken: "rotated-refresh",
        providerSpecificData: { connectionProxyUrl: "operator-new-proxy" },
      });
    } finally { spy.mockRestore(); }
  });
});
