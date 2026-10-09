import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: vi.fn(), getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
const NOW = Date.parse("2026-10-08T00:00:00Z");
const response = (body, status=200) => new Response(JSON.stringify(body), { status });
let deps, state, run;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW); mocks.fetch.mockReset();
  ({runQuotaAutoPingTick:run}=await import("../../src/shared/services/quotaAutoPing.js"));
  deps={
    getSettings:vi.fn(async()=>({claudeAutoPing:{connections:{account:true}}})),
    getProviderConnections:vi.fn(async()=>[{id:"account",provider:"claude",authType:"oauth",accessToken:"synthetic-token"}]),
    resolveConnectionProxyConfig:vi.fn(async()=>({})),
    refreshAndUpdateCredentials:vi.fn(async connection=>({connection,refreshed:false})),
    updateProviderConnection:vi.fn(async()=>({})), proxyAwareFetch:vi.fn(async()=>({ok:false})),
  };
  state={running:false,resetCache:{},failureCache:{}};
});
afterEach(()=>vi.useRealTimers());
describe("auto-ping quota observation freshness",()=>{
  it("routes using the limiting core window, while keeping model-specific limits separate", async () => {
    mocks.fetch.mockResolvedValueOnce(response({
      five_hour: { utilization: 10, resets_at: new Date(NOW + 360_000).toISOString() },
      seven_day: { utilization: 97, resets_at: new Date(NOW + 86400_000).toISOString() },
      seven_day_sonnet: { utilization: 100, resets_at: new Date(NOW + 86400_000).toISOString() },
    }));
    await run(deps, state);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("account", {
      lastQuota: { remainingPercentage: 3, resetAt: new Date(NOW + 86400_000).toISOString(), at: NOW },
    });
  });
  it("clears an old routing snapshot when the current provider observation fails", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "account", provider: "claude", authType: "oauth", accessToken: "synthetic-token", lastQuota: { at: NOW, remainingPercentage: 90 } }]);
    mocks.fetch.mockResolvedValueOnce(response({ five_hour: { utilization: 10, resets_at: new Date(NOW + 360_000).toISOString() } }));
    await run(deps, state);
    vi.setSystemTime(NOW + 361_000);
    mocks.fetch.mockResolvedValueOnce(response({}, 429));
    await run(deps, state);
    expect(deps.updateProviderConnection).toHaveBeenLastCalledWith("account", { lastQuota: null });
  });
  it("does not re-stamp a cached headroom read as a fresh routing snapshot",async()=>{
    mocks.fetch.mockResolvedValueOnce(response({five_hour:{utilization:0,resets_at:new Date(NOW+360_000).toISOString()}}));
    await run(deps,state);
    vi.setSystemTime(NOW+120_000);
    await run(deps,state);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const snapshots=deps.updateProviderConnection.mock.calls.filter(([,patch])=>patch.lastQuota);
    expect(snapshots[1][1].lastQuota.at).toBe(NOW);
  });
  it("does not overwrite routing headroom after a failed quota refresh",async()=>{
    mocks.fetch.mockResolvedValueOnce(response({five_hour:{utilization:0,resets_at:new Date(NOW+360_000).toISOString()}}));
    await run(deps,state);
    vi.setSystemTime(NOW+361_000);
    mocks.fetch.mockResolvedValueOnce(response({error:"too many requests"},429)).mockResolvedValueOnce(response({error:"no admin"},403));
    await run(deps,state);
    const snapshots=deps.updateProviderConnection.mock.calls.filter(([,patch])=>patch.lastQuota);
    expect(snapshots).toHaveLength(1);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });
  it("keeps a rotated token under the same account quota cooldown without changing health", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ error: "too many requests" }, 429));
    await run(deps, state);
    vi.setSystemTime(NOW + 60_000);
    deps.getProviderConnections.mockResolvedValue([{
      id: "account", provider: "claude", authType: "oauth", accessToken: "rotated-token",
    }]);
    await run(deps, state);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
