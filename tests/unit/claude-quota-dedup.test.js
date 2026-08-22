/**
 * Claude quota fetcher — per-token dedup + TTL cache (upstream cd4003bc).
 *
 * Covers: in-flight promise dedup keyed by accessToken, fresh-cache serving
 * within TTL, stale-on-soft-failure fallback, and force bypass.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_USAGE = {
  five_hour: { utilization: 20, resets_at: "2026-08-01T15:00:00Z" },
  seven_day: { utilization: 55, resets_at: "2026-08-04T00:00:00Z" },
};

async function loadModule() {
  return import("../../open-sse/services/usage/claude.js");
}

describe("getClaudeUsage dedup + cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("dedups concurrent calls for the same token into a single fetch", async () => {
    const { getClaudeUsage } = await loadModule();
    // Slow response so both callers land while the first is in flight
    let resolveFetch;
    proxyAwareFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = () => resolve(jsonResponse(OK_USAGE));
      }),
    );

    const p1 = getClaudeUsage("tok-a");
    const p2 = getClaudeUsage("tok-a");
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(r1.quotas["session (5h)"].used).toBe(20);
    expect(r2).toBe(r1);
  });

  it("serves a fresh cached result within TTL without refetching", async () => {
    const { getClaudeUsage } = await loadModule();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_USAGE));

    const first = await getClaudeUsage("tok-b");
    const second = await getClaudeUsage("tok-b");

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("keys the cache by access token (different tokens do not share entries)", async () => {
    const { getClaudeUsage } = await loadModule();
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(OK_USAGE))
      .mockResolvedValueOnce(
        jsonResponse({ five_hour: { utilization: 90, resets_at: null } }),
      );

    const a = await getClaudeUsage("tok-1");
    const b = await getClaudeUsage("tok-2");

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(a.quotas["session (5h)"].used).toBe(20);
    expect(b.quotas["session (5h)"].used).toBe(90);
  });

  it("does not cache soft failures and falls back to the last good result", async () => {
    const { getClaudeUsage } = await loadModule();
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(OK_USAGE)) // good read → cached
      .mockResolvedValueOnce(jsonResponse({ error: "rate_limited" }, 429));

    await getClaudeUsage("tok-c");
    const degraded = await getClaudeUsage("tok-c");

    // Second hit was a 429 soft failure: last good quotas served instead
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(degraded.quotas["weekly (7d)"].remainingPercentage).toBe(45);

    // Soft failure was NOT cached: third call goes back out
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ five_hour: { utilization: 10, resets_at: null } }),
    );
    await getClaudeUsage("tok-c");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("force=true skips the cache and refetches", async () => {
    const { getClaudeUsage } = await loadModule();
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(OK_USAGE))
      .mockResolvedValueOnce(
        jsonResponse({ five_hour: { utilization: 77, resets_at: null } }),
      );

    await getClaudeUsage("tok-d");
    const forced = await getClaudeUsage("tok-d", null, { force: true });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(forced.quotas["session (5h)"].used).toBe(77);
  });
});
