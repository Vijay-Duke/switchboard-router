import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  clear: vi.fn(),
  mark: vi.fn(),
  core: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null,
  getProviderCredentials: mocks.get,
  markAccountUnavailable: mocks.mark,
  clearAccountError: mocks.clear,
}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({}),
  getCombos: async () => [],
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: "test-key", lease: null }),
  runWithClientKeyLease: (_lease, fn) => fn(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: (_key, fn) => fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, creds) => creds,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.core,
}));
vi.mock("@/lib/db/repos/fetchCacheRepo.js", () => ({
  getFetchCache: async () => null,
}));

import { handleSearch } from "@/sse/handlers/search.js";

const ollamaCredentials = {
  connectionId: "ollama-connection",
  connectionName: "Ollama Cloud",
  apiKey: "ollama-key",
};

function searchRequest(provider) {
  return new Request("http://localhost/v1/web/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, query: "what is a router" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.core.mockResolvedValue({
    success: true,
    response: new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    }),
  });
  mocks.mark.mockResolvedValue({ shouldFallback: false });
});

describe("search credential fallback", () => {
  it("reuses the linked chat provider's credentials when the search provider has none", async () => {
    mocks.get.mockImplementation(async (providerId) =>
      providerId === "ollama" ? ollamaCredentials : null);

    const response = await handleSearch(searchRequest("ollama-search"));

    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenNthCalledWith(1, "ollama-search", expect.any(Set), "websearch:ollama-search", expect.anything());
    expect(mocks.get).toHaveBeenNthCalledWith(2, "ollama", expect.any(Set), "websearch:ollama-search", expect.anything());

    const coreCall = mocks.core.mock.calls[0][0];
    expect(coreCall.provider.id).toBe("ollama-search");
    expect(coreCall.credentials).toEqual(ollamaCredentials);
  });

  it("does not consult the fallback when the search provider has its own connection", async () => {
    const ownCredentials = {
      connectionId: "ollama-search-connection",
      connectionName: "Dedicated key",
      apiKey: "own-key",
    };
    mocks.get.mockResolvedValue(ownCredentials);

    await handleSearch(searchRequest("ollama-search"));

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith("ollama-search", expect.any(Set), "websearch:ollama-search", expect.anything());
    expect(mocks.core.mock.calls[0][0].credentials).toEqual(ownCredentials);
  });

  it("reports missing credentials when neither provider has a connection", async () => {
    mocks.get.mockResolvedValue(null);

    const response = await handleSearch(searchRequest("ollama-search"));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toMatch(/No credentials for provider: ollama-search/);
  });

  it("scopes failure locks to the search capability of the reused connection", async () => {
    mocks.get.mockImplementation(async (providerId) =>
      providerId === "ollama" ? ollamaCredentials : null);
    mocks.core.mockResolvedValue({
      success: false,
      status: 500,
      error: "upstream search failure",
      response: new Response(JSON.stringify({ error: "upstream search failure" }), { status: 500 }),
    });

    const response = await handleSearch(searchRequest("ollama-search"));

    expect(response.status).toBe(500);
    expect(mocks.mark).toHaveBeenCalledWith(
      "ollama-connection",
      500,
      "upstream search failure",
      "ollama-search",
      "websearch:ollama-search",
    );
  });

  it("searches glm directly without a credential fallback", async () => {
    mocks.get.mockResolvedValue({ connectionId: "glm-conn", connectionName: "GLM", apiKey: "glm-key" });

    await handleSearch(searchRequest("glm"));

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith("glm", expect.any(Set), "websearch:glm", expect.anything());
    expect(mocks.core.mock.calls[0][0].providerConfig.baseUrl).toBe(
      "https://api.z.ai/api/mcp/web_search_prime/mcp",
    );
  });
});
