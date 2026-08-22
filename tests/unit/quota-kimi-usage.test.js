/**
 * Kimi usage handler — upstream 6eaa9f83.
 *
 * Covers: dual-auth header selection (x-api-key vs Bearer + X-Msh-* with a
 * stable device id), plan-name mapping, Weekly/Ratelimit quota mapping
 * (remainingPercentage only, never absolute `remaining`), and the critical
 * auth-vs-permission error split (401 = re-auth; 403 permission_denied must
 * NOT match our route's AUTH_EXPIRED_PATTERNS).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getKimiUsage, formatKimiUsageError } from "../../open-sse/services/usage/kimi.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_OAUTH_PAYLOAD = {
  user: { membership: { level: "LEVEL_ADVANCED" } },
  usage: { limit: 1000, used: 250 },
  limits: [{ detail: { limit: 60, remaining: 42, resetTime: "2026-08-22T18:00:00Z" } }],
};

describe("getKimiUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("OAuth path: Bearer + X-Msh-* headers with stable device id", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_OAUTH_PAYLOAD));

    await getKimiUsage("tok-1", null, null, { deviceId: "device-fixed-1" });
    const [, init] = proxyAwareFetch.mock.calls[0];

    expect(init.headers.Authorization).toBe("Bearer tok-1");
    expect(init.headers["X-Msh-Platform"]).toBe("switchboard");
    expect(init.headers["X-Msh-Device-Id"]).toBe("device-fixed-1");

    // Same deviceId → same header on a second call (stability contract)
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_OAUTH_PAYLOAD));
    await getKimiUsage("tok-1", null, null, { deviceId: "device-fixed-1" });
    expect(proxyAwareFetch.mock.calls[1][1].headers["X-Msh-Device-Id"]).toBe("device-fixed-1");
  });

  it("apiKey path: x-api-key only, no OAuth headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_OAUTH_PAYLOAD));

    await getKimiUsage(null, "sk-kimi-key", null, { deviceId: "unused" });
    const [, init] = proxyAwareFetch.mock.calls[0];

    expect(init.headers["x-api-key"]).toBe("sk-kimi-key");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-Msh-Device-Id"]).toBeUndefined();
  });

  it("missing credentials returns a message without fetching", async () => {
    const res = await getKimiUsage(null, null, null, null);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(res.message).toMatch(/not available/i);
  });

  it("maps usage + limits into remainingPercentage quotas (no absolute remaining)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(OK_OAUTH_PAYLOAD));

    const res = await getKimiUsage("tok", null);
    expect(res.plan).toBe("Allegro"); // LEVEL_ADVANCED
    expect(res.quotas.Weekly).toEqual({
      used: 250,
      total: 1000,
      remainingPercentage: 75,
      resetAt: null,
      unlimited: false,
    });
    expect(res.quotas.Ratelimit.used).toBe(18); // 60 - 42
    expect(res.quotas.Ratelimit.remainingPercentage).toBeCloseTo(70);

    for (const q of Object.values(res.quotas)) {
      expect(q).not.toHaveProperty("remaining"); // UI reads `remaining` as 0-100%
    }
  });

  it("unknown membership level degrades to 'Kimi Coding' plan", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        user: { membership: { level: "LEVEL_FUTURE_TIER" } },
        usage: { limit: 10, used: 1 },
        limits: [],
      }),
    );

    const res = await getKimiUsage("tok", null);
    expect(res.plan).toBe("future_tier");
  });

  it("empty usage payload still yields plan + message, no quotas object crash", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ user: { membership: { level: "LEVEL_BASIC" } }, usage: {}, limits: [] }),
    );

    const res = await getKimiUsage("tok", null);
    expect(res.plan).toBe("Moderato");
    expect(res.message).toBeTruthy();
    expect(res.quotas).toBeUndefined();
  });
});

describe("formatKimiUsageError / error-path fetches", () => {
  beforeEach(() => vi.clearAllMocks());

  // Our route treats these words as session-expired and kills the connection:
  // ["expired","authentication","unauthorized","401","re-authorize"]
  const AUTH_EXPIRED_PATTERNS = [
    "expired",
    "authentication",
    "unauthorized",
    "401",
    "re-authorize",
  ];

  it("403 REASON_FEATURE_NO_PERMISSION message avoids AUTH_EXPIRED_PATTERNS", async () => {
    const msg = formatKimiUsageError(
      403,
      JSON.stringify({
        code: "permission_denied",
        details: [
          {
            debug: {
              reason: "REASON_FEATURE_NO_PERMISSION",
              localizedMessage: { message: "Subscribe to Kimi Code to access this feature." },
            },
          },
        ],
      }),
    );
    for (const pattern of AUTH_EXPIRED_PATTERNS) {
      expect(msg.toLowerCase()).not.toContain(pattern);
    }
    expect(msg).toMatch(/subscribe/i);
  });

  it("401 maps to an explicit re-authorize message", () => {
    const msg = formatKimiUsageError(401, "{}");
    expect(msg).toMatch(/expired|re-authorize/i);
  });

  it("a 403 during fetch produces a non-expiring message on the result", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: "permission_denied" }, 403),
    );
    const res = await getKimiUsage("tok", null);
    for (const pattern of AUTH_EXPIRED_PATTERNS) {
      expect((res.message || "").toLowerCase()).not.toContain(pattern);
    }
    expect(res.plan).toBe("Kimi Coding");
  });

  it("network failure fails soft with a message", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await getKimiUsage("tok", null);
    expect(res.message).toMatch(/Unable to fetch usage/);
  });
});
