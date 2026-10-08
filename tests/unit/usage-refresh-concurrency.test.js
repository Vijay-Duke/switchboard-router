import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), executorOverride: null,
  updateProviderConnectionCredentialsIfCurrent: vi.fn(), getProviderConnectionById: vi.fn(),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/initOpenSseDeps.js", () => ({}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/db/index.js", () => ({
  updateProviderConnectionCredentialsIfCurrent: mocks.updateProviderConnectionCredentialsIfCurrent,
  updateProviderConnection: vi.fn(), updateProviderConnectionStatusIfCurrent: vi.fn(),
  getProviderConnectionById: mocks.getProviderConnectionById,
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/executors/index.js", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, getExecutor: provider => mocks.executorOverride || actual.getExecutor(provider) };
});
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
const connection = () => ({
  id: "synthetic-account", provider: "claude", authType: "oauth",
  accessToken: "expired-access", refreshToken: "single-use-refresh",
  expiresAt: new Date(Date.now() - 1000).toISOString(), providerSpecificData: {},
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
function rotatingProvider() {
  const seen = [];
  let finishFirst;
  mocks.fetch.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.refresh_token);
    if (seen.length > 1) return json({ error: "invalid_grant", error_description: "refresh token already consumed" }, 400);
    return new Promise(resolve => { finishFirst = () => resolve(json({
      access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 28800,
    })); });
  });
  return { seen, finish: () => finishFirst() };
}
let stored;
beforeEach(() => {
  vi.resetModules();
  mocks.fetch.mockReset();
  stored = connection();
  mocks.executorOverride = null;
  mocks.getProviderConnectionById.mockReset().mockImplementation(async () => structuredClone(stored));
  mocks.updateProviderConnectionCredentialsIfCurrent.mockReset().mockImplementation(async (_id, expected, patch) => {
    if (stored.accessToken !== expected.accessToken || stored.refreshToken !== expected.refreshToken) return null;
    stored = { ...stored, ...patch,
      ...(patch.providerSpecificData ? { providerSpecificData: { ...stored.providerSpecificData, ...patch.providerSpecificData } } : {}),
    };
    return structuredClone(stored);
  });
});
describe("usage refresh single-use token concurrency audit", () => {
  it("does not consume the same refresh token twice for concurrent usage readers", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const provider = rotatingProvider();
    const a = refreshAndUpdateCredentials(connection());
    const b = refreshAndUpdateCredentials(connection());
    await vi.waitFor(() => expect(provider.seen.length).toBeGreaterThan(0));
    provider.finish();
    const results = await Promise.all([a, b]);
    expect(provider.seen).toEqual(["single-use-refresh"]);
    expect(results.map(r => r.connection.accessToken)).toEqual(["new-access", "new-access"]);
  });
  it("shares refresh protection between usage and the central credential manager", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const { refreshProviderCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");
    const provider = rotatingProvider();
    const central = refreshProviderCredentials("claude", { ...connection(), connectionId: "synthetic-account" }, { info: vi.fn(), error: vi.fn() });
    await vi.waitFor(() => expect(provider.seen).toHaveLength(1));
    const usage = refreshAndUpdateCredentials(connection());
    provider.finish();
    const [refreshed, quota] = await Promise.all([central, usage]);
    expect(provider.seen).toEqual(["single-use-refresh"]);
    expect(refreshed.accessToken).toBe("new-access");
    expect(quota.connection.accessToken).toBe("new-access");
  });
  it("reuses persisted rotated credentials instead of replaying a stale caller snapshot", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const provider = rotatingProvider();
    const stale = connection();
    const first = refreshAndUpdateCredentials(stale);
    await vi.waitFor(() => expect(provider.seen).toHaveLength(1));
    provider.finish();
    await first;
    const second = await refreshAndUpdateCredentials(stale, true);
    expect(provider.seen).toEqual(["single-use-refresh"]);
    expect(second.connection.accessToken).toBe("new-access");
  });
  it("returns another writer's new credentials when its own refresh is rejected", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    mocks.fetch.mockImplementation(async () => {
      stored = { ...stored, accessToken: "writer-access", refreshToken: "writer-refresh" };
      return json({ error: "invalid_grant" }, 400);
    });
    const result = await refreshAndUpdateCredentials(connection());
    expect(result.connection).toMatchObject({ accessToken: "writer-access", refreshToken: "writer-refresh" });
    expect(mocks.updateProviderConnectionCredentialsIfCurrent).not.toHaveBeenCalled();
  });
  it("does not overwrite another writer's newer token pair with a late successful result", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const provider = rotatingProvider();
    const pending = refreshAndUpdateCredentials(connection());
    await vi.waitFor(() => expect(provider.seen).toHaveLength(1));
    stored = { ...stored, accessToken: "writer-access", refreshToken: "writer-refresh" };
    provider.finish();
    const result = await pending;
    expect(result.connection).toMatchObject({ accessToken: "writer-access", refreshToken: "writer-refresh" });
    expect(stored.accessToken).toBe("writer-access");
  });
  it("retains special-provider executor behavior, proxy options and newer operator settings", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    stored = {
      ...connection(), provider: "github",
      providerSpecificData: { connectionProxyUrl: "old-proxy", copilotToken: "old-copilot" },
    };
    const refresh = vi.fn(async () => {
      stored.providerSpecificData = { ...stored.providerSpecificData, connectionProxyUrl: "operator-new-proxy" };
      return {
        copilotToken: "new-copilot", copilotTokenExpiresAt: 9999999999,
        providerSpecificData: { connectionProxyUrl: "old-proxy", refreshedScope: "new-scope" },
      };
    });
    mocks.executorOverride = { needsRefresh: () => true, refreshCredentials: refresh };
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "selected-proxy" };
    const result = await refreshAndUpdateCredentials(structuredClone(stored), false, proxyOptions);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: stored.id, copilotToken: "old-copilot" }), console, proxyOptions,
    );
    expect(result.connection.providerSpecificData).toMatchObject({
      connectionProxyUrl: "operator-new-proxy", copilotToken: "new-copilot", refreshedScope: "new-scope",
    });
  });
  it("reuses a consumed-token result while its first persistence operation is still pending", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const provider = rotatingProvider();
    const persist = mocks.updateProviderConnectionCredentialsIfCurrent.getMockImplementation();
    let entered, releasePersistence;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { releasePersistence = resolve; });
    mocks.updateProviderConnectionCredentialsIfCurrent.mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return persist(...args);
    });
    const first = refreshAndUpdateCredentials(connection());
    await vi.waitFor(() => expect(provider.seen).toHaveLength(1));
    provider.finish();
    await enteredPromise;
    const second = refreshAndUpdateCredentials(connection());
    await new Promise(resolve => setTimeout(resolve, 20));
    releasePersistence();
    const results = await Promise.all([first, second]);
    expect(provider.seen).toEqual(["single-use-refresh"]);
    expect(results.map(r => r.connection.accessToken)).toEqual(["new-access", "new-access"]);
  });
  it("preserves a quota joiner's newer operator config when the central refresh returns merged metadata", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const { withCredentialRefreshLock, mergeRefreshedCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");
    stored.providerSpecificData = { connectionProxyUrl: "old-proxy" };
    const initial = structuredClone(stored);
    let entered, releaseRefresh;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { releaseRefresh = resolve; });
    const central = withCredentialRefreshLock("claude", { ...initial, connectionId: initial.id }, async () => {
      entered();
      await held;
      return mergeRefreshedCredentials("claude", initial, {
        accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 28800,
        providerSpecificData: { refreshedScope: "new-scope" },
      });
    });
    await enteredPromise;
    stored.providerSpecificData.connectionProxyUrl = "operator-new-proxy";
    const usage = refreshAndUpdateCredentials(structuredClone(stored));
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseRefresh();
    const [, result] = await Promise.all([central, usage]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(result.connection.providerSpecificData).toMatchObject({
      connectionProxyUrl: "operator-new-proxy", refreshedScope: "new-scope",
    });
  });
  it("completes actual CodexExecutor refresh without joining its own nested lock", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    stored = { ...connection(), provider: "codex" };
    mocks.fetch.mockResolvedValueOnce(json({
      access_token: "codex-new-access", refresh_token: "codex-new-refresh", expires_in: 3600,
    }));
    let timer;
    try {
      const result = await Promise.race([
        refreshAndUpdateCredentials(structuredClone(stored)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("nested credential refresh lock deadlocked")), 1000);
        }),
      ]);
      expect(result.connection.accessToken).toBe("codex-new-access");
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); }
  });
  it("preserves absolute issued expiry when a successful receipt is reused later", async () => {
    const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");
    vi.useFakeTimers();
    const issuedAt = Date.parse("2026-10-08T00:00:00Z");
    vi.setSystemTime(issuedAt);
    const initial = connection();
    const refresh = vi.fn(async () => ({
      accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600,
    }));
    try {
      await withCredentialRefreshLock("claude", initial, refresh);
      vi.setSystemTime(issuedAt + 600_000);
      const reused = await withCredentialRefreshLock("claude", initial, refresh);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(reused.expiresAt).toBe(new Date(issuedAt + 3_600_000).toISOString());
      expect(reused.expiresIn).toBe(3000);
    } finally { vi.useRealTimers(); }
  });
  it("retries a genuinely failed refresh instead of caching its failure", async () => {
    const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");
    const refresh = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      accessToken: "new-access", refreshToken: "rotated-refresh",
    });
    expect(await withCredentialRefreshLock("claude", connection(), refresh)).toBeNull();
    expect(await withCredentialRefreshLock("claude", connection(), refresh)).toMatchObject({ accessToken: "new-access" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("does not let an old successful receipt roll central persistence back to an older generation", async () => {
    const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const initial = structuredClone(stored);
    await withCredentialRefreshLock("claude", initial, async () => ({
      accessToken: "first-rotated-access", refreshToken: "first-rotated-refresh", expiresIn: 28800,
    }));
    stored = { ...stored, accessToken: "later-access", refreshToken: "later-refresh" };
    const result = await checkAndRefreshToken("claude", initial, { force: true });
    expect(result).toMatchObject({ accessToken: "later-access", refreshToken: "later-refresh" });
    expect(stored).toMatchObject({ accessToken: "later-access", refreshToken: "later-refresh" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not OAuth-refresh a row whose auth type changed before re-reading it", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const initial = structuredClone(stored);
    stored.authType = "apikey";
    const result = await refreshAndUpdateCredentials(initial, true);
    expect(result.connection.authType).toBe("apikey");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not extend persisted or execution expiry when a receipt is reused between seconds", async () => {
    const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    vi.useFakeTimers();
    const issuedAt = Date.parse("2026-10-08T00:00:00Z");
    vi.setSystemTime(issuedAt);
    stored = connection();
    const initial = structuredClone(stored);
    try {
      await withCredentialRefreshLock("claude", initial, async () => ({
        accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600,
      }));
      vi.setSystemTime(issuedAt + 600_001);
      const usage = await refreshAndUpdateCredentials(initial, true);
      const deadline = new Date(issuedAt + 3_600_000).toISOString();
      expect(usage.connection.expiresAt).toBe(deadline);
      const central = await checkAndRefreshToken("claude", initial, { force: true });
      expect(central.expiresAt).toBe(deadline);
      expect(stored.expiresAt).toBe(deadline);
    } finally { vi.useRealTimers(); }
  });
  it("retries actual Claude refresh after a transient upstream failure", async () => {
    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    mocks.fetch.mockResolvedValueOnce(json({ error: "temporarily unavailable" }, 500))
      .mockResolvedValueOnce(json({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
    const initial = connection();
    expect((await refreshAndUpdateCredentials(initial)).refreshed).toBe(false);
    const next = await refreshAndUpdateCredentials(initial);
    expect(next.connection.accessToken).toBe("new-access");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
