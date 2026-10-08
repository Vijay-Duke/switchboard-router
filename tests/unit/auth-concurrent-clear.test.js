import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), updateProviderConnectionStatusIfCurrent: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({ ...mocks, getSettings: vi.fn(async () => ({})), getConnectionInFlightCount: vi.fn(() => 0) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })) }));
const { clearAccountError, markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const NOW = Date.parse("2026-10-08T00:00:00Z");
let current;
const initial = () => ({
  id: "c1", provider: "claude", testStatus: "unavailable", lastError: "old error",
  lastErrorAt: new Date(NOW - 20_000).toISOString(), modelLock_model: new Date(NOW - 1_000).toISOString(),
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); current = initial();
  mocks.getProviderConnections.mockImplementation(async () => [structuredClone(current)]);
  mocks.updateProviderConnection.mockImplementation(async (_id, patch) => { Object.assign(current, patch); return structuredClone(current); });
  mocks.updateProviderConnection.mockClear();
  mocks.updateProviderConnectionStatusIfCurrent.mockImplementation(async (id, expected, patch) => mocks.updateProviderConnection(id, patch));
});
afterEach(() => vi.useRealTimers());
describe("successful request clearing concurrent account errors", () => {
  it("preserves a newer 429 cooldown created after credential selection", async () => {
    const selected = structuredClone(current);
    await markAccountUnavailable("c1", 429, "rate limit exceeded", "claude", "model");
    const lock = current.modelLock_model;
    await clearAccountError("c1", { _connection: selected }, "model");
    expect(current).toMatchObject({ modelLock_model: lock, testStatus: "unavailable", lastError: "rate limit exceeded", backoffLevel: 1 });
  });
  it("does not clear an account-wide lock imposed while a request was running", async () => {
    const selected = { ...current, modelLock___all: new Date(NOW - 1_000).toISOString() };
    current = { ...selected };
    await markAccountUnavailable("c1", 429, "rate limit exceeded", "claude", null);
    const lock = current.modelLock___all;
    await clearAccountError("c1", { _connection: selected }, "model");
    expect(current.modelLock___all).toBe(lock);
    expect(current.testStatus).toBe("unavailable");
  });
  it("preserves a revoked-refresh marker recorded after selection", async () => {
    const selected = structuredClone(current);
    current.testStatus = "reauth_required"; current.lastError = "reconnect account";
    await clearAccountError("c1", { _connection: selected }, "model");
    expect(current).toMatchObject({ testStatus: "reauth_required", lastError: "reconnect account" });
  });
  it("clears old expired locks and error status when no new error occurred", async () => {
    await clearAccountError("c1", { _connection: structuredClone(current) }, "model");
    expect(current).toMatchObject({ modelLock_model: null, testStatus: "active", lastError: null, backoffLevel: 0 });
  });
  it("serializes an error write against a successful clear already awaiting persistence", async () => {
    let releaseClear;
    let clearEntered;
    const heldClear = new Promise(resolve => { releaseClear = resolve; });
    const entered = new Promise(resolve => { clearEntered = resolve; });
    mocks.updateProviderConnection.mockImplementationOnce(async (_id, patch) => {
      clearEntered();
      await heldClear;
      Object.assign(current, patch);
      return structuredClone(current);
    });
    const clearing = clearAccountError("c1", { _connection: structuredClone(current) }, "model");
    await entered;
    const marking = markAccountUnavailable("c1", 429, "rate limit exceeded", "claude", "model");
    await vi.advanceTimersByTimeAsync(0);
    releaseClear();
    await Promise.all([clearing, marking]);
    expect(current).toMatchObject({ testStatus: "unavailable", lastError: "rate limit exceeded", backoffLevel: 1 });
    expect(new Date(current.modelLock_model).getTime()).toBeGreaterThan(NOW);
  });
});
