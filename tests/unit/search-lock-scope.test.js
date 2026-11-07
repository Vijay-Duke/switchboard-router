/**
 * Search failures must lock a search-scoped key, never the account-wide
 * `__all` lock: a shared chat+search key (e.g. glm, tavily) would otherwise go
 * offline for chat because one search request failed (upstream ec669280).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
}));
const core = vi.hoisted(() => ({ handleSearchCore: vi.fn() }));

vi.mock("../../src/sse/services/auth.js", () => auth);
vi.mock("open-sse/handlers/search/index.js", () => core);
vi.mock("@/lib/db/index.js", () => ({ getSettings: async () => ({}), getCombos: async () => [] }));
vi.mock("@/lib/db/repos/fetchCacheRepo.js", () => ({ getFetchCache: async () => null }));
vi.mock("../../src/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: null, lease: null }),
  runWithClientKeyLease: async (_lease, work) => work(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_p, c) => c,
}));

const { handleSearch } = await import("../../src/sse/handlers/search.js");

function req(provider) {
  return new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, query: "hello" }),
  });
}

describe("search failure lock scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads and writes locks under websearch:<provider>, not the account-wide key", async () => {
    auth.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "c1", connectionName: "one", apiKey: "k" })
      .mockResolvedValueOnce(null);
    core.handleSearchCore.mockResolvedValueOnce({ success: false, status: 500, error: "boom", response: new Response("boom", { status: 500 }) });
    auth.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true, cooldownMs: 1000 });

    await handleSearch(req("tavily"));

    expect(auth.getProviderCredentials).toHaveBeenCalled();
    for (const call of auth.getProviderCredentials.mock.calls) {
      expect(call[2]).toBe("websearch:tavily");
    }
    expect(auth.markAccountUnavailable).toHaveBeenCalledWith("c1", 500, "boom", "tavily", "websearch:tavily");
  });
});
