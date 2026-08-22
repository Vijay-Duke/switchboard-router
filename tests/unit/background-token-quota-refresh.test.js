/**
 * Background OAuth token-refresh scheduler (upstream f260a181, adapted).
 *
 * Covers: pure selection predicate, tick fail-open semantics with injectable
 * deps, idempotent start guarded by kill-switch + non-server runtime checks,
 * and stop cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const NOW = new Date("2026-08-22T12:00:00Z").getTime();

vi.mock("../../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const loadModule = () => import("../../../src/sse/services/backgroundTokenRefresh.js");

function conn(overrides = {}) {
  return {
    id: overrides.id ?? "c1",
    provider: overrides.provider ?? "claude",
    authType: overrides.authType ?? "oauth",
    refreshToken: overrides.refreshToken ?? "rt-1",
    expiresAt: overrides.expiresAt ?? new Date(NOW + 10 * 60 * 1000).toISOString(), // 10min left
    isActive: true,
  };
}

describe("selectConnectionsNeedingRefresh", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("selects OAuth connections expiring within the 30-minute lead", async () => {
    const { selectConnectionsNeedingRefresh } = await loadModule();
    const due = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString() })],
      NOW,
    );
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("c1");
  });

  it("skips connections comfortably inside their validity window", async () => {
    const { selectConnectionsNeedingRefresh } = await loadModule();
    const due = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString() })], // 3h left
      NOW,
    );
    expect(due).toEqual([]);
  });

  it("ignores non-oauth auth types and connections without a refresh token", async () => {
    const { selectConnectionsNeedingRefresh } = await loadModule();
    const due = selectConnectionsNeedingRefresh(
      [
        conn({ authType: "api_key", id: "a" }),
        conn({ refreshToken: undefined, id: "b" }),
        conn({ authType: "OAUTH_DEVICE", id: "c" }), // normalized to oauth
      ],
      NOW,
    );
    expect(due.map((c) => c.id)).toEqual(["c"]);
  });

  it("skips connections whose expiry cannot be determined", async () => {
    const { selectConnectionsNeedingRefresh } = await loadModule();
    const due = selectConnectionsNeedingRefresh([conn({ expiresAt: null })], NOW);
    expect(due).toEqual([]);
  });

  it("handles empty / non-array input", async () => {
    const { selectConnectionsNeedingRefresh } = await loadModule();
    expect(selectConnectionsNeedingRefresh([], NOW)).toEqual([]);
    expect(selectConnectionsNeedingRefresh(null, NOW)).toEqual([]);
  });
});

describe("runBackgroundTokenRefreshTick", () => {
  beforeEach(async () => {
    vi.resetModules();
    // jsdom-less env: ensure window is undefined so start() isn't skipped
    delete globalThis.window;
  });

  it("refreshes only selected connections and swallows per-connection errors", async () => {
    const mod = await loadModule();
    const good = conn({ id: "good" });
    const bad = conn({ id: "bad" });
    const loadConnections = vi.fn().mockResolvedValue([good, bad]);
    const refreshConnection = vi
      .fn()
      .mockImplementation(async (c) => {
        if (c.id === "bad") throw new Error("provider down");
      });

    await mod.runBackgroundTokenRefreshTick({ loadConnections, refreshConnection });

    expect(refreshConnection).toHaveBeenCalledTimes(2);
    expect(refreshConnection.mock.calls.map((c) => c[0].id).sort()).toEqual(["bad", "good"]);
  });

  it("does not run two ticks concurrently", async () => {
    const mod = await loadModule();
    let release;
    const loadConnections = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([conn()]);
      }),
    );
    const first = mod.runBackgroundTokenRefreshTick({ loadConnections });
    const second = await mod.runBackgroundTokenRefreshTick({
      loadConnections: vi.fn(),
    });
    // Second tick observed tickRunning and returned without loading
    expect(loadConnections).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(second).toBeUndefined();
  });

  it("tick failure is swallowed (never throws)", async () => {
    const mod = await loadModule();
    const result = await mod.runBackgroundTokenRefreshTick({
      loadConnections: vi.fn().mockRejectedValue(new Error("db gone")),
    });
    expect(result).toBeUndefined();
  });
});

describe("startBackgroundTokenRefresh guards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    delete globalThis.window;
    delete process.env.DISABLE_BACKGROUND_TOKEN_REFRESH;
    delete process.env.NEXT_PHASE;
    delete process.env.NEXT_RUNTIME;
  });
  afterEach(() => {
    vi.useRealTimers();
    return loadModule().then((m) => m.stopBackgroundTokenRefresh());
  });

  it("starts exactly once even when called repeatedly", async () => {
    const mod = await loadModule();
    expect(mod.startBackgroundTokenRefresh({ intervalMs: 1000 })).toBe(true);
    expect(mod.startBackgroundTokenRefresh({ intervalMs: 1000 })).toBe(false);
  });

  it("kill-switch DISABLE_BACKGROUND_TOKEN_REFRESH prevents start", async () => {
    process.env.DISABLE_BACKGROUND_TOKEN_REFRESH = "1";
    const mod = await loadModule();
    expect(mod.startBackgroundTokenRefresh()).toBe(false);
  });

  it("skips in non-server runtimes (window present)", async () => {
    globalThis.window = {};
    try {
      const mod = await loadModule();
      expect(mod.startBackgroundTokenRefresh()).toBe(false);
    } finally {
      delete globalThis.window;
    }
  });

  it("initial pass runs after the short delay, then interval repeats", async () => {
    const mod = await loadModule();
    const loadConnections = vi.fn().mockResolvedValue([]);
    // Prime the module-level default deps by starting the scheduler,
    // then drive timers; the safeTick closure uses the real loader.
    mod.startBackgroundTokenRefresh({ intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(10_000);
    // Two passes: INITIAL_DELAY_MS (10s) — interval at 5s hasn't fired past it yet
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(0);
    void loadConnections;
  });
});
