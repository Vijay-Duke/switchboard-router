import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  proxyAwareFetch: vi.fn(),
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

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

describe("ClinePass connection tests", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.testProxyUrl.mockResolvedValue({ ok: true });
    mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
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
    mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ id: "user-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await testSingleConnection("clinepass-oauth");

    expect(result).toMatchObject({ valid: true, error: null });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/users/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer workos:oauth-token" }),
        identity: "cline",
        provider: "clinepass",
        format: "openai",
      }),
      {},
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
    mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const result = await testSingleConnection("clinepass-key");

    expect(result).toMatchObject({ valid: true, error: null });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer cline-key" },
        identity: "cline",
        provider: "clinepass",
        format: "openai",
      }),
      {},
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "clinepass-key",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });

  it("keeps the ClinePass identity profile when a rejected token is refreshed and retried", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "clinepass-refresh",
      provider: "clinepass",
      authType: "oauth",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      providerSpecificData: {},
    });
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accessToken: "fresh-token", refreshToken: "next-refresh" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user-1" }), { status: 200 }));

    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    const result = await testSingleConnection("clinepass-refresh");

    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(1,
      "https://api.cline.bot/api/v1/users/me",
      expect.objectContaining({ identity: "cline", provider: "clinepass", format: "openai" }),
      {},
    );
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(2,
      expect.stringContaining("/api/v1/auth/refresh"),
      expect.objectContaining({ identity: "cline", provider: "clinepass", format: "openai" }),
      {},
    );
    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(3,
      "https://api.cline.bot/api/v1/users/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer workos:fresh-token" }),
        identity: "cline",
        provider: "clinepass",
        format: "openai",
      }),
      {},
    );
  });

  it.each([
    ["codex", "codex-cli", "openai-responses", "https://chatgpt.com/backend-api/codex/responses", 400],
    ["gemini-cli", "gemini-cli", "gemini-cli", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", 200],
    ["github", "copilot", "openai", "https://api.github.com/user", 200],
  ])("uses the %s registry identity for provider probes", async (provider, identity, format, expectedUrl, status) => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: `${provider}-oauth`,
      provider,
      authType: "oauth",
      accessToken: "oauth-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      providerSpecificData: {},
    });
    mocks.proxyAwareFetch.mockResolvedValue(new Response("{}", { status }));

    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    const result = await testSingleConnection(`${provider}-oauth`);

    expect(result.valid).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ identity, provider, format }),
      {},
    );
  });
});
