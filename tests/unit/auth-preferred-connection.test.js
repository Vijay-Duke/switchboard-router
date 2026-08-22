import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
  getConnectionInFlightCount: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getConnectionInFlightCount: mocks.getConnectionInFlightCount,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {},
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const CONNECTIONS = [
  { id: "first", name: "First", apiKey: "first-key", providerSpecificData: {} },
  { id: "second", name: "Second", apiKey: "second-key", providerSpecificData: {} },
];

describe("preferred provider connection selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue(CONNECTIONS);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("does not fall back to another account for strict verification requests", async () => {
    const credentials = await getProviderCredentials(
      "test",
      new Set(["second"]),
      "model-1",
      { preferredConnectionId: "second", strictPreferredConnection: true },
    );

    expect(credentials).toBeNull();
  });

  it("preserves preferred-then-fallback behavior for normal pinned requests", async () => {
    const credentials = await getProviderCredentials(
      "test",
      new Set(["second"]),
      "model-1",
      { preferredConnectionId: "second" },
    );

    expect(credentials.connectionId).toBe("first");
  });

  it("keeps fill-first behavior when balanced scheduling is disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { test: { accountScheduler: { enabled: false } } },
    });

    const credentials = await getProviderCredentials("test", null, "model-1");

    expect(credentials).toMatchObject({
      connectionId: "first",
      selectionReason: "fill-first",
      affinityRebound: false,
    });
    expect(mocks.getConnectionInFlightCount).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps sticky round-robin selection and persistence when scheduling is missing", async () => {
    const current = {
      ...CONNECTIONS[1],
      lastUsedAt: "2026-08-22T11:59:00.000Z",
      consecutiveUseCount: 1,
    };
    mocks.getProviderConnections.mockResolvedValue([
      { ...CONNECTIONS[0], lastUsedAt: "2026-08-22T11:00:00.000Z" },
      current,
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 3,
    });

    const credentials = await getProviderCredentials("test", null, "model-1");

    expect(credentials).toMatchObject({
      connectionId: "second",
      selectionReason: "round-robin",
    });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("second", {
      lastUsedAt: expect.any(String),
      consecutiveUseCount: 2,
    });
    expect(mocks.getConnectionInFlightCount).not.toHaveBeenCalled();
  });
});
