import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createProviderQuotaStateStore } from "@/lib/db/repos/providerQuotaStateStore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
let adapter, directory, store, file;
const identity = { connectionId: "account-a", provider: "claude", authType: "oauth", createdAt: "2026-01-01T00:00:00Z", email: "", accountId: "", organizationId: "" };
const options = { connectionId: identity.connectionId, quotaIdentity: identity };
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
async function coldHandler() {
  vi.resetModules();
  const { setOpenSseDeps } = await import("../../open-sse/runtimeDeps.js");
  setOpenSseDeps(store);
  return (await import("../../open-sse/services/usage/claude.js")).getClaudeUsage;
}
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-quota-durable-"));
  file = path.join(directory, "state.sqlite");
  adapter = await createNodeSqliteAdapter(file);
  store = createProviderQuotaStateStore(async () => adapter);
  adapter.exec(buildCreateTableSql("kv", TABLES.kv));
  adapter.exec(buildCreateTableSql("providerConnections", TABLES.providerConnections));
});
beforeEach(() => { adapter.run("DELETE FROM kv"); adapter.run("DELETE FROM providerConnections"); adapter.run("INSERT INTO providerConnections(id,provider,authType,email,createdAt,updatedAt,data) VALUES(?,?,?,?,?,?,?)", [identity.connectionId, identity.provider, identity.authType, identity.email, identity.createdAt, identity.createdAt, "{}"]); proxyAwareFetch.mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T04:00:00Z")); });
afterEach(() => vi.useRealTimers());
afterAll(() => { adapter.close(); fs.rmSync(directory, { recursive: true, force: true }); });
describe("Claude quota cold process state", () => {
  it("keeps a long Retry-After through a module restart and token rotation", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" })).mockResolvedValue(response({}));
    const first = await (await coldHandler())("old-token", null, options);
    vi.advanceTimersByTime(60000);
    const restarted = await (await coldHandler())("new-token", null, { ...options, force: true });
    expect(restarted.retryAt).toBe(first.retryAt);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
  it("restores the genuine last observation with a stale warning during cooldown", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 37, resets_at: "2026-10-08T08:00:00Z" } }));
    const handler = await coldHandler();
    const fresh = await handler("old-token", null, options);
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
    await handler("old-token", null, { ...options, force: true });
    vi.advanceTimersByTime(60000);
    proxyAwareFetch.mockResolvedValue(response({}));
    const restarted = await (await coldHandler())("new-token", null, options);
    expect(restarted).toMatchObject({ stale: true, status: 429, observedAt: fresh.observedAt, quotas: fresh.quotas });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("survives a new process with the same SQLite file and no outbound transport", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 37 } }));
    const handler = await coldHandler();
    const fresh = await handler("synthetic-old-token", null, options);
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "86400" }));
    const limited = await handler("synthetic-old-token", null, { ...options, force: true });
    const loader = path.join(directory, "offline-loader.mjs");
    fs.writeFileSync(loader, `export async function load(url, context, next) {
      if (url.endsWith("/open-sse/utils/proxyFetch.js")) return { format: "module", shortCircuit: true, source: 'export async function proxyAwareFetch(){globalThis.__quotaCalls=(globalThis.__quotaCalls||0)+1;throw new Error("offline transport prohibited")}' };
      return next(url, context);
    }`);
    const root = path.resolve(import.meta.dirname, "../..");
    const code = `
      import { createNodeSqliteAdapter } from ${JSON.stringify("file://" + path.join(root, "src/lib/db/adapters/nodeSqliteAdapter.js"))};
      import { createProviderQuotaStateStore } from ${JSON.stringify("file://" + path.join(root, "src/lib/db/repos/providerQuotaStateStore.js"))};
      import { setOpenSseDeps } from ${JSON.stringify("file://" + path.join(root, "open-sse/runtimeDeps.js"))};
      import { getClaudeUsage } from ${JSON.stringify("file://" + path.join(root, "open-sse/services/usage/claude.js"))};
      const db = await createNodeSqliteAdapter(process.argv[1]);
      setOpenSseDeps(createProviderQuotaStateStore(async () => db));
      const result = await getClaudeUsage("rotated-synthetic-token", null, JSON.parse(process.argv[2]));
      console.log(JSON.stringify({ result, calls: globalThis.__quotaCalls || 0 }));
      db.close();
    `;
    const child = spawnSync(process.execPath, ["--no-warnings", "--loader", loader, "--input-type=module", "-e", code, file, JSON.stringify({ ...options, force: true })], { encoding: "utf8", timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const restarted = JSON.parse(child.stdout.trim());
    expect(restarted).toMatchObject({ calls: 0, result: { stale: true, status: 429, retryAt: limited.retryAt, observedAt: fresh.observedAt, quotas: fresh.quotas } });
  });

  it("only uses a restored successful observation until its genuine five-minute TTL", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 20 } }));
    const first = await (await coldHandler())("token", null, options);
    vi.advanceTimersByTime(60000);
    expect(await (await coldHandler())("rotated-token", null, options)).toMatchObject(first);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(240000);
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 21 } }));
    expect((await (await coldHandler())("rotated-again", null, options)).quotas["session (5h)"].used).toBe(21);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves 401 failure alongside the last good observation after restart", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 20 } }));
    await (await coldHandler())("token", null, options);
    vi.advanceTimersByTime(300001);
    proxyAwareFetch.mockResolvedValueOnce(response({}, 401));
    const failed = await (await coldHandler())("expired-token", null, options);
    expect(failed).toMatchObject({ stale: true, status: 401, code: "authentication_error" });
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 22 } }));
    const recovered = await (await coldHandler())("new-token", null, options);
    expect(recovered.quotas["session (5h)"].used).toBe(22);
    expect(recovered.stale).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("does not reuse another account's quotas or cooldown at the same connection ID", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 37 } }));
    const handler = await coldHandler();
    await handler("old-token", null, options);
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
    await handler("old-token", null, { ...options, force: true });
    adapter.run("UPDATE providerConnections SET email = ? WHERE id = ?", ["new-account@example.test", identity.connectionId]);
    expect(await handler("old-token", null, options)).toMatchObject({ code: "connection_changed" });
    const newOptions = { ...options, quotaIdentity: { ...identity, email: "new-account@example.test" } };
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 4 } }));
    const fresh = await handler("new-account-token", null, newOptions);
    expect(fresh.quotas["session (5h)"].used).toBe(4);
    expect(fresh.stale).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["provider", "authType", "createdAt"])("rejects mismatched %s and deletion before polling", async field => {
    adapter.run(`UPDATE providerConnections SET ${field} = ? WHERE id = ?`, ["changed", identity.connectionId]);
    expect(await (await coldHandler())("token", null, options)).toMatchObject({ code: "connection_changed" });
    adapter.run("DELETE FROM providerConnections");
    expect(await (await coldHandler())("token", null, options)).toMatchObject({ code: "connection_changed" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects a late response for an account replaced during the upstream request", async () => {
    proxyAwareFetch.mockImplementationOnce(async () => {
      adapter.run("UPDATE providerConnections SET email = ? WHERE id = ?", ["replacement@example.test", identity.connectionId]);
      return response({ five_hour: { utilization: 37 } });
    });
    expect(await (await coldHandler())("token", null, options)).toMatchObject({ code: "connection_changed" });
    expect(adapter.get("SELECT value FROM kv WHERE scope = ?", ["providerQuotaState"])).toBeUndefined();
  });

  it("deduplicates simultaneous cold callers including a forced refresh", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
    const handler = await coldHandler();
    const calls = await Promise.all(Array.from({ length: 10 }, (_, n) => handler("token" + n, null, { ...options, force: n % 2 === 0 })));
    expect(new Set(calls.map(item => item.retryAt)).size).toBe(1);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on storage reads and retains in-process backoff on failed writes", async () => {
    const handler = await coldHandler();
    // coldHandler reset runtime deps, so obtain its current instance.
    const currentDeps = (await import("../../open-sse/runtimeDeps.js")).setOpenSseDeps;
    currentDeps({ loadProviderQuotaState: async () => { throw new Error("storage offline"); } });
    expect(await handler("token", null, options)).toMatchObject({ code: "quota_state_unavailable" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    currentDeps({ ...store, saveProviderQuotaState: async () => { throw new Error("storage offline"); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
      const first = await handler("token", null, options);
      const again = await handler("rotated", null, { ...options, force: true });
      expect(again.retryAt).toBe(first.retryAt);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it("merges concurrent durable responses without shortening a newer Retry-After", async () => {
    const fresh = { observedAt: new Date().toISOString(), quotas: { "session (5h)": { used: 37, total: 100, remaining: 63, remainingPercentage: 63 } } };
    await store.saveProviderQuotaState(identity, { result: fresh, expiresAt: Date.now() + 300000 });
    await store.saveProviderQuotaState(identity, { retryAt: "2026-10-08T06:00:00Z" });
    await store.saveProviderQuotaState(identity, { retryAt: "2026-10-08T05:00:00Z" });
    await store.saveProviderQuotaState(identity, { result: { ...fresh, observedAt: "2026-10-08T04:01:00Z" }, expiresAt: Date.now() + 300000 });
    const state = await store.loadProviderQuotaState(identity);
    expect(state).toMatchObject({ retryAt: "2026-10-08T06:00:00.000Z", expiresAt: 0, result: { observedAt: "2026-10-08T04:01:00.000Z" } });
  });

  it("never persists tokens, headers, response errors or arbitrary extra usage fields", async () => {
    await store.saveProviderQuotaState(identity, {
      accessToken: "SECRET-ACCESS", headers: { authorization: "SECRET-BEARER" }, retryAt: "2026-10-08T05:00:00Z",
      result: { plan: "Claude Code", observedAt: new Date().toISOString(), quotas: {}, accessToken: "SECRET-TOKEN", extraUsage: { is_enabled: true, used_credits: 12, token: "SECRET-NESTED" } },
    });
    const stored = adapter.get("SELECT value FROM kv WHERE scope = ?", ["providerQuotaState"]).value;
    expect(stored).not.toMatch(/SECRET|accessToken|authorization|headers|token/i);
    expect(JSON.parse(stored).result.extraUsage).toEqual({ is_enabled: true, used_credits: 12 });
  });


  it("invalidates a concurrently saved fresh snapshot after a cold caller fails", async () => {
    const fresh = { observedAt: new Date().toISOString(), quotas: {} };
    await store.saveProviderQuotaState(identity, { result: fresh, expiresAt: Date.now() + 300000 });
    await store.saveProviderQuotaState(identity, { result: null, retryAt: null, expiresAt: 0 });
    expect(await store.loadProviderQuotaState(identity)).toMatchObject({ result: fresh, expiresAt: 0 });
  });

  it("does not hide a forced401 when its invalidation cannot be persisted", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 37 } }));
    const handler = await coldHandler();
    await handler("token", null, options);
    const setDeps = (await import("../../open-sse/runtimeDeps.js")).setOpenSseDeps;
    setDeps({ saveProviderQuotaState: async () => { throw new Error("storage offline"); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      proxyAwareFetch.mockResolvedValueOnce(response({}, 401));
      expect(await handler("token", null, { ...options, force: true })).toMatchObject({ stale: true, status: 401 });
      proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 38 } }));
      expect((await handler("rotated-token", null, options)).quotas["session (5h)"].used).toBe(38);
      expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    } finally { warn.mockRestore(); }
  });

  it("fails closed when the durable state is corrupt", async () => {
    adapter.run("INSERT INTO kv(scope,key,value) VALUES(?,?,?)", ["providerQuotaState", identity.connectionId, "{broken"]);
    expect(await (await coldHandler())("token", null, options)).toMatchObject({ code: "quota_state_unavailable" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("seeds the existing cooldown offline and rejects a rebound account identity", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const usageFile = path.join(directory, "old-usage.json");
    const identityFile = path.join(directory, "old-identity.json");
    const retryAt = new Date(vi.getRealSystemTime() + 3600000).toISOString();
    fs.writeFileSync(usageFile, JSON.stringify({ status: 429, code: "rate_limited", retryAt, quotas: { fake: { used: 99 } } }));
    fs.writeFileSync(identityFile, JSON.stringify(identity));
    const command = [path.join(root, "scripts/seed-provider-quota-state.mjs"), file, identity.connectionId, usageFile, identityFile];
    const seeded = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 15000 });
    expect(seeded.status, seeded.stderr).toBe(0);
    expect(await store.loadProviderQuotaState(identity)).toEqual({ retryAt, expiresAt: 0, result: null });
    adapter.run("UPDATE providerConnections SET email = ? WHERE id = ?", ["rebound@example.test", identity.connectionId]);
    const rejected = spawnSync(process.execPath, command, { encoding: "utf8", timeout: 15000 });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).not.toMatch(/synthetic|token|rebound@example/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("does not drop a longer persisted deadline when another process observes429", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 37 } }));
    const handler = await coldHandler();
    await handler("token", null, options);
    await store.saveProviderQuotaState(identity, { retryAt: "2026-10-08T05:00:00Z" });
    expect(await handler("token", null, options)).toMatchObject({ stale: true, status: 429, retryAt: "2026-10-08T05:00:00.000Z" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("polls again only after the restored provider deadline and clears the expired cooldown", async () => {
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
    await (await coldHandler())("old-token", null, options);
    vi.advanceTimersByTime(3600000);
    proxyAwareFetch.mockResolvedValueOnce(response({ five_hour: { utilization: 18 } }));
    expect((await (await coldHandler())("rotated-token", null, options)).quotas["session (5h)"].used).toBe(18);
    expect((await store.loadProviderQuotaState(identity)).retryAt).toBeNull();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });


  it("keeps repeated standalone cache reads fresh without an app persistence hook", async () => {
    vi.resetModules();
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    proxyAwareFetch.mockResolvedValue(response({ five_hour: { utilization: 37 } }));
    const first = await getClaudeUsage("token", null, { connectionId: "standalone" });
    for (let n = 0; n < 4; n++) expect(await getClaudeUsage("token", null, { connectionId: "standalone" })).toEqual(first);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

});
