import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

describe("ClinePass connection tests", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.testProxyUrl.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("tests an OAuth connection with WorkOS-authenticated Cline headers", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "clinepass-oauth",
      provider: "clinepass",
      authType: "oauth",
      accessToken: "oauth-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      providerSpecificData: {},
    });
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "user-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await testSingleConnection("clinepass-oauth");

    expect(result).toMatchObject({ valid: true, error: null });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/users/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer workos:oauth-token" }),
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "clinepass-oauth",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });

  it("tests an API-key connection stored with the legacy ClinePass alias", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "clinepass-key",
      provider: "cline-pass",
      authType: "apikey",
      apiKey: "cline-key",
      providerSpecificData: {},
    });
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await testSingleConnection("clinepass-key");

    expect(result).toMatchObject({ valid: true, error: null });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer cline-key" },
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "clinepass-key",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });
});
