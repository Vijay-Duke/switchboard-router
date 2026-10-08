import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/index.js", () => ({
  ...mocks,
  getSettings: vi.fn(async () => ({})),
  getConnectionInFlightCount: vi.fn(() => 0),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })),
}));
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const NOW = Date.parse("2026-10-08T00:00:00Z");
const until = (seconds) => new Date(NOW + seconds * 1_000).toISOString();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());
describe("requested-model cooldown retry timing", () => {
  it("ignores an earlier unrelated model lock", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "c1", modelLock_requested: until(120), modelLock_other: until(5),
      lastError: "rate limit", errorCode: 429,
    }]);
    const out = await getProviderCredentials("claude", null, "requested");
    expect(out.retryAfter).toBe(until(120));
  });
  it("waits for both requested-model and account locks", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "c1", modelLock_requested: until(5), modelLock___all: until(120),
    }]);
    expect((await getProviderCredentials("claude", null, "requested")).retryAfter).toBe(until(120));
  });
  it("uses the earliest usable account and its matching error", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", modelLock_requested: until(120), lastError: "slow reset", errorCode: 503 },
      { id: "c2", modelLock_requested: until(60), lastError: "quick reset", errorCode: 429 },
    ]);
    expect(await getProviderCredentials("claude", null, "requested")).toMatchObject({
      retryAfter: until(60), lastError: "quick reset", lastErrorCode: 429,
    });
  });
});
