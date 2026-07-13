import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/shared/constants/providers.js", () => ({
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
});
