import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: vi.fn(async () => ({})),
  getConnectionInFlightCount: vi.fn(() => 0),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
}));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const CONN = [{ id: "c1", name: "Chat", backoffLevel: 2 }];

beforeEach(() => {
  mocks.getProviderConnections.mockResolvedValue(CONN);
  mocks.updateProviderConnection.mockClear();
});

describe("markAccountUnavailable precise reset", () => {
  it("locks until the upstream reset and self-reports an exhausted quota snapshot", async () => {
    const resetsAtMs = Date.now() + 60 * 60 * 1000;
    const out = await markAccountUnavailable(
      "c1", 429, "[429]: The usage limit has been reached", "codex", "gpt-5.6-sol", resetsAtMs,
    );

    expect(out.shouldFallback).toBe(true);
    expect(out.cooldownMs).toBeGreaterThan(59 * 60 * 1000);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        testStatus: "unavailable",
        errorCode: 429,
        backoffLevel: 0,
        lastQuota: { remainingPercentage: 0, resetAt: new Date(resetsAtMs).toISOString(), at: expect.any(Number) },
      }),
    );
    const payload = mocks.updateProviderConnection.mock.calls[0][1];
    expect(Object.keys(payload).some((k) => k.startsWith("modelLock_"))).toBe(true);
  });

  it("caps a far-future reset at MAX_RATE_LIMIT_COOLDOWN_MS", async () => {
    const out = await markAccountUnavailable(
      "c1", 429, "usage limit reached", "codex", "m", Date.now() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(out.cooldownMs).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    const payload = mocks.updateProviderConnection.mock.calls[0][1];
    // Snapshot resetAt stays the true upstream reset even when the lock is capped.
    expect(payload.lastQuota.resetAt).not.toBe(new Date(Date.now() + MAX_RATE_LIMIT_COOLDOWN_MS).toISOString());
  });

  it("does not write a quota snapshot without a precise reset", async () => {
    await markAccountUnavailable("c1", 429, "rate limit exceeded", "codex", "m");
    const payload = mocks.updateProviderConnection.mock.calls[0][1];
    expect(payload.lastQuota).toBeUndefined();
    expect(payload.backoffLevel).toBe(3); // conn.backoffLevel=2 escalated
  });
});
