import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", ...headers },
});
const goodUsage = { five_hour: { utilization: 37, resets_at: "2026-10-08T08:00:00Z" } };
beforeEach(() => {
  vi.resetModules();
  proxyAwareFetch.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T04:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("Claude subscription quota failures", () => {
  it("reports and honors a long upstream cooldown across force, token rotation, and background checks", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    proxyAwareFetch.mockResolvedValueOnce(response({ error: { type: "rate_limit_error", message: "Rate limited" } }, 429, { "retry-after": "2821" }));
    const first = await getClaudeUsage("oauth-token", null, { connectionId: "account-a" });
    expect(first).toMatchObject({ status: 429, code: "rate_limited", retryAt: "2026-10-08T04:47:01.000Z" });
    expect(first.message).not.toMatch(/admin/i);
    expect(first.message).toContain("04:47:01");
    expect(first.quotas).toBeUndefined();
    vi.advanceTimersByTime(181000);
    const again = await getClaudeUsage("rotated-oauth-token", null, { connectionId: "account-a", force: true });
    expect(again.retryAt).toBe(first.retryAt);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2640000);
    proxyAwareFetch.mockResolvedValueOnce(response(goodUsage));
    const recovered = await getClaudeUsage("rotated-oauth-token", null, { connectionId: "account-a" });
    expect(recovered.quotas["session (5h)"].remainingPercentage).toBe(63);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls.every(([url]) => url.endsWith("/api/oauth/usage"))).toBe(true);
  });

  it("keeps last good quotas through repeated failures and a forced refresh", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    proxyAwareFetch.mockResolvedValueOnce(response(goodUsage));
    await getClaudeUsage("token", null, { connectionId: "a" });
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "2101" }));
    const stale = await getClaudeUsage("token", null, { connectionId: "a", force: true });
    expect(stale).toMatchObject({ stale: true, status: 429, code: "rate_limited" });
    expect(stale.quotas["session (5h)"].used).toBe(37);
    const immediate = await getClaudeUsage("token", null, { connectionId: "a" });
    expect(immediate).toMatchObject({ stale: true, status: 429, retryAt: stale.retryAt });
    expect(immediate.message).toContain("rate-limited");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(6 * 60000);
    const next = await getClaudeUsage("rotated", null, { connectionId: "a" });
    expect(next.quotas).toEqual(stale.quotas);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves authentication failure so the route can refresh the OAuth session", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    proxyAwareFetch.mockResolvedValueOnce(response({ error: { type: "authentication_error" } }, 401));
    const expired = await getClaudeUsage("old-token", null, { connectionId: "a" });
    expect(expired).toMatchObject({ status: 401, code: "authentication_error" });
    expect(expired.message).toMatch(/expired|unauthorized/i);
    proxyAwareFetch.mockResolvedValueOnce(response(goodUsage));
    expect((await getClaudeUsage("new-token", null, { connectionId: "a" })).quotas).toBeDefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("uses the connected OAuth credential, not a gateway/API key, for subscription usage", async () => {
    const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
    proxyAwareFetch.mockResolvedValueOnce(response(goodUsage));
    const data = await getUsageForProvider({ id: "account-a", provider: "claude", authType: "oauth", accessToken: "legitimate-oauth", apiKey: "irrelevant-api-key" });
    expect(data.quotas["session (5h)"].used).toBe(37);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer legitimate-oauth");
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "3600" }));
    await getUsageForProvider({ id: "account-a", provider: "claude", authType: "oauth", accessToken: "legitimate-oauth" }, null, { force: true });
    await getUsageForProvider({ id: "account-a", provider: "claude", authType: "oauth", accessToken: "rotated-oauth" }, null, { force: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("accepts an HTTP-date Retry-After without converting it to the short fallback", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    proxyAwareFetch.mockResolvedValueOnce(response({}, 429, { "retry-after": "Thu, 08 Oct 2026 05:00:00 GMT" }));
    expect((await getClaudeUsage("token")).retryAt).toBe("2026-10-08T05:00:00.000Z");
  });
});
