/**
 * Meta Muse usage — quota comes from the CLI's own startup key-mint call
 * (POST /muse-code/key), whose response carries `subs_usage` alongside the
 * inference key.
 *
 * Covers: DCA-token auth (never the minted key), window/weekly parsing with
 * epoch-second resets, plan selection, idle/no-subscription readings that
 * must not render fake bars, and the auth-expired signal the /api/usage
 * route relies on for its force-refresh retry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getMuseUsage } from "../../open-sse/services/usage/muse.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";

const MINT_URL = "https://api.meta.ai/muse-code/key";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mintBody(overrides = {}) {
  return {
    api_key: "LLM|minted-key",
    base_url: "https://api.meta.ai/v1",
    subs_tier_name: "Muse Code Power Usage",
    subs_tier_id: "tier_power",
    is_subs_active: true,
    subs_usage: {
      window: { used_percent: 42, window_duration_mins: 300, resets_at: 1789568145 },
      weekly: { used_percent: 10, resets_at: 1790086545 },
    },
    ...overrides,
  };
}

describe("getMuseUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses window + weekly subs_usage into quota bars", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(mintBody()));

    const res = await getMuseUsage("dca:token");

    expect(res.plan).toBe("Muse Code Power Usage");
    expect(res.quotas["Session (5h)"]).toEqual({
      used: 42,
      total: 100,
      remaining: 58,
      remainingPercentage: 58,
      resetAt: new Date(1789568145 * 1000).toISOString(),
      unlimited: false,
    });
    expect(res.quotas["Weekly (7d)"]).toMatchObject({
      used: 10,
      total: 100,
      remaining: 90,
      resetAt: new Date(1790086545 * 1000).toISOString(),
    });
  });

  it("auths the mint call with the DCA token, never the minted key", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(mintBody()));

    await getMuseUsage("dca:token");

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Authorization": "Bearer dca:token",
          "x-api-version": "1.0.0",
        }),
        identity: "muse-code",
        provider: "muse",
      }),
      null,
    );
  });

  it("falls back to subs_usage.tier for the plan label", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(mintBody({ subs_tier_name: "", subs_usage: {
        tier: "Power Usage",
        window: { used_percent: 5, window_duration_mins: 300, resets_at: 1789568145 },
      } })),
    );

    const res = await getMuseUsage("dca:token");
    expect(res.plan).toBe("Power Usage");
    expect(res.quotas["Session (5h)"].used).toBe(5);
  });

  it("skips windows without a numeric used_percent instead of zero-filling", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(mintBody({ subs_usage: { weekly: { used_percent: 20, resets_at: 1790086545 } } })),
    );

    const res = await getMuseUsage("dca:token");
    expect(res.quotas["Session (5h)"]).toBeUndefined();
    expect(res.quotas["Weekly (7d)"].used).toBe(20);
  });

  it("keeps plan with an idle message when Meta omits subs_usage", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(mintBody({ subs_usage: null })));

    const res = await getMuseUsage("dca:token");
    expect(res.plan).toBe("Muse Code Power Usage");
    expect(res.quotas).toEqual({});
    expect(res.message).toMatch(/idle/i);
  });

  it("reports no subscription without fake bars when is_subs_active is false", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(mintBody({ is_subs_active: false, subs_usage: null })),
    );

    const res = await getMuseUsage("dca:token");
    expect(res.plan).toBe("Muse Code Power Usage");
    expect(res.quotas).toEqual({});
    expect(res.message).toMatch(/No active subscription/i);
  });

  it("clamps out-of-range percents into 0..100", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse(mintBody({ subs_usage: {
        window: { used_percent: 250, window_duration_mins: 300, resets_at: 1789568145 },
        weekly: { used_percent: -5, resets_at: 1790086545 },
      } })),
    );

    const res = await getMuseUsage("dca:token");
    expect(res.quotas["Session (5h)"].used).toBe(100);
    expect(res.quotas["Weekly (7d)"].used).toBe(0);
  });

  it("401 maps to the auth-expired message the usage route retries on", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const res = await getMuseUsage("dca:stale");
    expect(res.message).toMatch(/expired/i);
    expect(res.message).toMatch(/re-authorize/i);
  });

  it("returns a soft message on upstream errors instead of throwing", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    const res = await getMuseUsage("dca:token");
    expect(res.message).toMatch(/temporarily unavailable \(500\)/);
  });

  it("missing DCA returns a message without fetching", async () => {
    const res = await getMuseUsage(undefined);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(res.message).toMatch(/requires OAuth sign-in/i);
  });

  it("missing DCA falls back to the stored plan label", async () => {
    const res = await getMuseUsage("", { subsTierName: "Pro" });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(res.plan).toBe("Pro");
    expect(res.quotas).toEqual({});
  });

  it("dispatch routes muse and sources the DCA token from refreshToken", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(mintBody()));

    // Legacy rows predate providerSpecificData.dcaToken; refreshToken holds it.
    const res = await getUsageForProvider({
      provider: "muse",
      accessToken: "LLM|minted-key",
      refreshToken: "dca:legacy",
    });

    expect(res.message ?? "").not.toBe("Usage API not implemented for muse");
    expect(res.plan).toBe("Muse Code Power Usage");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ "Authorization": "Bearer dca:legacy" }),
      }),
      null,
    );
  });
});
