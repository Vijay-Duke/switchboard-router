import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
const mocks = vi.hoisted(() => ({ getAdapter: vi.fn(), connection: null, fetch: vi.fn(), executor: { needsRefresh: () => false } }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: async () => mocks.connection,
  updateProviderConnectionCredentialsIfCurrent: vi.fn(),
  getSettings: vi.fn(), getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => mocks.executor }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
let adapter, directory;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-quota-wiring-"));
  adapter = await createNodeSqliteAdapter(path.join(directory, "test.sqlite"));
  for (const table of ["kv", "providerConnections"]) adapter.exec(buildCreateTableSql(table, TABLES[table]));
});
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T04:00:00Z")); mocks.fetch.mockReset();
  mocks.getAdapter.mockResolvedValue(adapter);
  adapter.run("DELETE FROM kv"); adapter.run("DELETE FROM providerConnections");
  mocks.connection = { id: "account", provider: "claude", authType: "oauth", accessToken: "synthetic-token", createdAt: "2026-01-01T00:00:00Z" };
  const c = mocks.connection;
  adapter.run("INSERT INTO providerConnections(id,provider,authType,createdAt,updatedAt,data) VALUES(?,?,?,?,?,?)", [c.id, c.provider, c.authType, c.createdAt, c.createdAt, "{}"]);
});
afterEach(() => vi.useRealTimers());
afterAll(() => { adapter.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const readRoute = async force => {
  const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
  const response = await GET(new Request("http://localhost/api/usage/account" + (force ? "?force=1" : "")), { params: Promise.resolve({ connectionId: "account" }) });
  return response.json();
};
describe("durable quota app wiring", () => {
  it("shares restored cooldown and original observation between the real API route and direct auto-ping", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ five_hour: { utilization: 37, resets_at: "2026-10-08T08:00:00Z" } }));
    const fresh = await readRoute(false);
    mocks.fetch.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
    const limited = await readRoute(true);
    expect(limited).toMatchObject({ stale: true, status: 429, observedAt: fresh.observedAt });
    vi.advanceTimersByTime(60000); vi.resetModules();
    mocks.connection = { ...mocks.connection, accessToken: "rotated-synthetic-token" };
    const { runQuotaAutoPingTick } = await import("../../src/shared/services/quotaAutoPing.js");
    const update = vi.fn();
    const ping = vi.fn();
    await runQuotaAutoPingTick({
      getSettings: async () => ({ claudeAutoPing: { connections: { account: true } } }),
      getProviderConnections: async () => [mocks.connection],
      resolveConnectionProxyConfig: async () => ({}),
      refreshAndUpdateCredentials: async connection => ({ connection, refreshed: false }),
      updateProviderConnection: update, proxyAwareFetch: ping,
    }, { running: false, resetCache: {}, failureCache: {} });
    const restored = await readRoute(true);
    expect(restored).toMatchObject({ stale: true, status: 429, retryAt: limited.retryAt, observedAt: fresh.observedAt, quotas: fresh.quotas });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});
