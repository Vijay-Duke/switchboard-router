/**
 * Ollama Cloud usage — upstream f260a181.
 *
 * Covers: real /api/usage fetch with Bearer key, 0..1 ratio → percentage
 * conversion for Session (5h) / Weekly (7d), fail-open plan label from
 * /api/me, auth errors, and the missing-key guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getOllamaUsage } from "../../open-sse/services/usage/misc.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockUsageAndMe(usageBody, meBody = { Plan: "max" }) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse(usageBody)) // GET /api/usage
    .mockResolvedValueOnce(jsonResponse(meBody)); // POST /api/me
}

describe("getOllamaUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("missing key returns a message without fetching", async () => {
    const res = await getOllamaUsage(null);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(res.message).toMatch(/not available/i);
  });

  it("converts 0..1 ratios into Session/Weekly percentage quotas", async () => {
    mockUsageAndMe({
      limits: { session: { usage: 0.42 }, weekly: { usage: 1 } },
    });

    const res = await getOllamaUsage("ok-key");
    expect(res.plan).toBe("Max");
    expect(res.quotas["Session (5h)"]).toEqual({
      used: 42,
      total: 100,
      remainingPercentage: 58,
      resetAt: null,
      unlimited: false,
    });
    // Ratio 1.0 → fully used bar, never an absolute `remaining`
    expect(res.quotas["Weekly (7d)"].used).toBe(100);
    expect(res.quotas["Weekly (7d)"].remainingPercentage).toBe(0);
    expect(res.quotas["Weekly (7d)"]).not.toHaveProperty("remaining");
  });

  it("clamps out-of-range ratios into 0..100", async () => {
    mockUsageAndMe({ limits: { session: { usage: 2.5 }, weekly: { usage: -3 } } });

    const res = await getOllamaUsage("k");
    expect(res.quotas["Session (5h)"].used).toBe(100);
    expect(res.quotas["Weekly (7d)"].used).toBe(0);
  });

  it("fails open on /api/me errors and still returns quotas", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(
        jsonResponse({ limits: { session: { usage: 0.1 }, weekly: { usage: 0.2 } } }),
      )
      .mockRejectedValueOnce(new Error("me endpoint down"));

    const res = await getOllamaUsage("k");
    expect(res.plan).toBe("Ollama Cloud");
    expect(Object.keys(res.quotas)).toHaveLength(2);
  });

  it("no limits reported yields a friendly message", async () => {
    mockUsageAndMe({ limits: {} });

    const res = await getOllamaUsage("k");
    expect(res.message).toMatch(/No usage limits reported/i);
  });

  it("401 maps to invalid-or-expired key message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 401));
    const res = await getOllamaUsage("bad");
    expect(res.message).toMatch(/invalid or expired/i);
  });
});
