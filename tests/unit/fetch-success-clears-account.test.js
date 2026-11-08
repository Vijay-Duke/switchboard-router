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
}));
vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: mocks.core,
}));
vi.mock("@/lib/db/repos/fetchCacheRepo.js", () => ({
  getFetchCache: async () => null,
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: () => {},
  assertPublicUrlResolved: async () => {},
}));

import { handleFetch } from "@/sse/handlers/fetch.js";

const credentials = {
  connectionId: "jina-connection",
  connectionName: "Jina Test",
  apiKey: "jina-key",
};

function request(provider = "jina-reader") {
  return new Request("http://localhost/v1/web/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, url: "https://example.com/article" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(credentials);
  mocks.core.mockResolvedValue({
    success: true,
    data: { provider: "jina-reader", content: { text: "ok" } },
  });
  mocks.mark.mockResolvedValue({ shouldFallback: false });
});

describe("web fetch account state", () => {
  it.each(["jina-reader", "jina-reader/fetch"])("routes %s and clears the web-fetch lock on success", async (provider) => {
    const response = await handleFetch(request(provider));

    expect(response.status).toBe(200);
    expect(mocks.clear).toHaveBeenCalledWith(
      "jina-connection",
      expect.objectContaining({ connectionName: "Jina Test" }),
      "webfetch:jina-reader",
    );
    expect(mocks.get).toHaveBeenCalledWith(
      "jina-reader",
      expect.any(Set),
      "webfetch:jina-reader",
      expect.anything(),
    );
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("scopes provider failures to web fetch", async () => {
    mocks.core.mockResolvedValue({
      success: false,
      status: 429,
      error: "quota exceeded",
    });

    const response = await handleFetch(request());

    expect(response.status).toBe(429);
    expect(mocks.mark).toHaveBeenCalledWith(
      "jina-connection",
      429,
      "quota exceeded",
      "jina-reader",
      "webfetch:jina-reader",
    );
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("scopes the lock key to the resolved ollama provider id", async () => {
    mocks.core.mockResolvedValue({ success: false, status: 500, error: "boom" });

    const response = await handleFetch(request("ollama"));

    expect(response.status).toBe(500);
    expect(mocks.get).toHaveBeenCalledWith("ollama", expect.any(Set), "webfetch:ollama", expect.anything());
    expect(mocks.mark).toHaveBeenCalledWith(
      "jina-connection",
      500,
      "boom",
      "ollama",
      "webfetch:ollama",
    );
  });
});
