import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getConnectionInFlightCount: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getConnectionInFlightCount: mocks.getConnectionInFlightCount,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: { free: { noAuth: true } },
  AI_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => mocks);

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { __resetAccountSchedulerForTests } = await import("../../src/sse/services/accountScheduler.js");
const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const base = [
  {
    id: "first",
    provider: "test",
    priority: 1,
    apiKey: "one",
    providerSpecificData: { connectionProxyUrl: "http://first" },
  },
  {
    id: "second",
    provider: "test",
    priority: 2,
    apiKey: "two",
    providerSpecificData: { connectionProxyUrl: "http://second" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetAccountSchedulerForTests();
  mocks.getProviderConnections.mockResolvedValue(base);
  mocks.getSettings.mockResolvedValue({
    fallbackStrategy: "fill-first",
    providerStrategies: {
      test: { accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 60 } },
    },
  });
  mocks.getConnectionInFlightCount.mockImplementation((id) => ({ first: 2, second: 0 })[id] || 0);
  mocks.resolveConnectionProxyConfig.mockImplementation(async (data) => ({
    connectionProxyEnabled: true,
    connectionProxyUrl: data.connectionProxyUrl,
  }));
});

it("preserves explicit and strict pinning ahead of scheduler scoring", async () => {
  const explicit = await getProviderCredentials("test", null, "m", {
    preferredConnectionId: "first",
    sessionKey: "s",
  });
  expect(explicit).toMatchObject({ connectionId: "first", selectionReason: "explicit-pin" });

  const strict = await getProviderCredentials("test", new Set(["first"]), "m", {
    preferredConnectionId: "first",
    strictPreferredConnection: true,
    sessionKey: "s",
  });
  expect(strict).toBeNull();
});

it("returns capacity exhaustion instead of violating a strict capped pin", async () => {
  mocks.getProviderConnections.mockResolvedValue([
    { ...base[0], maxConcurrentRequests: 1 },
    base[1],
  ]);
  mocks.getConnectionInFlightCount.mockImplementation((id) => (id === "first" ? 1 : 0));
  const result = await getProviderCredentials("test", null, "m", {
    preferredConnectionId: "first",
    strictPreferredConnection: true,
    sessionKey: "s",
  });
  expect(result).toMatchObject({
    allRateLimited: true,
    capacityLimited: true,
    selectionReason: "capacity-exhausted",
  });
});

it("uses least inflight, preserves the selected connection proxy, and logs the reason", async () => {
  const credentials = await getProviderCredentials("test", null, "m", {
    sessionKey: "session-do-not-log-9472",
  });
  expect(credentials).toMatchObject({
    connectionId: "second",
    selectionReason: "least-inflight",
    affinityRebound: false,
    providerSpecificData: { connectionProxyUrl: "http://second" },
  });
  expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith(base[1].providerSpecificData);
  expect(mocks.info).toHaveBeenCalledWith("AUTH", expect.stringContaining("selection=least-inflight"));
  expect(mocks.info).toHaveBeenCalledWith("AUTH", expect.stringContaining("rebound=false"));
  expect(mocks.info.mock.calls.flat().join(" ")).not.toContain("session-do-not-log-9472");
});

it("rebinds after exclusion and honors model cooldown filtering", async () => {
  mocks.getConnectionInFlightCount.mockReturnValue(0);
  const first = await getProviderCredentials("test", null, "m", { sessionKey: "conversation-secret" });
  const excluded = await getProviderCredentials("test", new Set([first.connectionId]), "m", {
    sessionKey: "conversation-secret",
  });
  expect(excluded.connectionId).toBe("second");
  expect(excluded.affinityRebound).toBe(true);
  expect(mocks.info.mock.calls.flat().join(" ")).not.toContain("conversation-secret");
  __resetAccountSchedulerForTests();
  mocks.getProviderConnections.mockResolvedValue([
    { ...base[0], modelLock_m: new Date(NOW + 60_000).toISOString() },
    base[1],
  ]);
  const cooldown = await getProviderCredentials("test", null, "m", {
    sessionKey: "cooldown-session",
  });
  expect(cooldown.connectionId).toBe("second");
});

it("invalidates affinity when hard filters temporarily remove every account", async () => {
  mocks.getConnectionInFlightCount.mockReturnValue(0);
  const first = await getProviderCredentials("test", null, "m", {
    sessionKey: "locked-session",
    clientKeyId: "client-a",
  });
  expect(first.connectionId).toBe("first");

  mocks.getProviderConnections.mockResolvedValue(base.map((connection) => ({
    ...connection,
    modelLock_m: new Date(NOW + 60_000).toISOString(),
  })));
  const locked = await getProviderCredentials("test", null, "m", {
    sessionKey: "locked-session",
    clientKeyId: "client-a",
  });
  expect(locked).toMatchObject({
    allRateLimited: true,
    selectionReason: "no-candidates",
    affinityRebound: true,
  });

  mocks.getProviderConnections.mockResolvedValue(base);
  mocks.getConnectionInFlightCount.mockImplementation((id) => (id === "first" ? 9 : 0));
  const recovered = await getProviderCredentials("test", null, "m", {
    sessionKey: "locked-session",
    clientKeyId: "client-a",
  });
  expect(recovered).toMatchObject({
    connectionId: "second",
    selectionReason: "least-inflight",
    affinityRebound: false,
  });
});

it("returns the compatibility unavailable envelope when every eligible account is capped", async () => {
  mocks.getProviderConnections.mockResolvedValue(base.map((connection) => ({
    ...connection,
    maxConcurrentRequests: 1,
  })));
  mocks.getConnectionInFlightCount.mockReturnValue(1);
  const result = await getProviderCredentials("test", null, "m", { sessionKey: "s" });
  expect(result).toMatchObject({
    allRateLimited: true,
    capacityLimited: true,
    lastErrorCode: 429,
    selectionReason: "capacity-exhausted",
  });
});

it("does not consult scheduler counters for no-auth providers", async () => {
  mocks.getSettings.mockResolvedValue({ providerStrategies: { free: {} } });
  const credentials = await getProviderCredentials("free", null, "m", { sessionKey: "s" });
  expect(credentials).toMatchObject({ id: "noauth", accessToken: "public" });
  expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  expect(mocks.getConnectionInFlightCount).not.toHaveBeenCalled();
});
