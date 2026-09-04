// H60/H61/H63 — max_results lower clamp, chat-search two-arg logging,
// non-Latin1 auth headers rejected instead of mangled.
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));
vi.mock("../../open-sse/utils/ssrfGuard.js", () => ({
  assertPublicUrl: vi.fn(),
  assertPublicUrlResolved: vi.fn().mockResolvedValue(undefined),
}));

import { handleSearchCore, sanitizeHeaders } from "../../open-sse/handlers/search/index.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const brave = (body, credentials, providerConfig = {}) => handleSearchCore({
  body, provider: { id: "brave-search" }, credentials, log: log(),
  providerConfig: { authType: credentials ? "apikey" : "none", baseUrl: "https://api.search.brave.com/res/v1", timeoutMs: 5000, ...providerConfig },
});

beforeEach(() => { proxyAwareFetch.mockReset(); });

describe("max_results clamp (H60)", () => {
  it.each([[-5, "1"], [0, "5"], ["abc", "5"], [3, "3"]])("max_results %s → count=%s", async (value, expected) => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ web: { results: [] } }));
    await brave({ query: "switchboard", max_results: value }, null);
    expect(new URL(proxyAwareFetch.mock.calls[0][0]).searchParams.get("count")).toBe(expected);
  });
});

describe("non-Latin1 auth headers (H63)", () => {
  it("unicode API key → 400, upstream never called", async () => {
    const result = await brave({ query: "switchboard" }, { apiKey: "ключ" });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toMatch(/non-Latin1/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("non-auth headers are still stripped, auth headers throw", () => {
    expect(sanitizeHeaders({ Accept: "appliécation/json✓" }).Accept).toBe("appliécation/json");
    expect(() => sanitizeHeaders({ Authorization: "Bearer k✓" })).toThrow(/non-Latin1/);
    expect(() => sanitizeHeaders({ "X-Subscription-Token": "k✓" })).toThrow(/non-Latin1/);
  });
});

describe("chat-search logging (H61)", () => {
  it("logs with the (tag, message) two-arg convention", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("boom"));
    const logger = log();
    const result = await handleChatSearch({ provider: "perplexity", query: "q", credentials: { apiKey: "k" }, log: logger });
    expect(result).toMatchObject({ success: false, status: 502 });
    expect(logger.error).toHaveBeenCalledWith("[chatSearch]", expect.stringContaining("network error"));
  });
});
