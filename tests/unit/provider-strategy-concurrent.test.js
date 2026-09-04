import { describe, expect, it, vi } from "vitest";
import {
  DELETE_PROVIDER_STRATEGY,
  patchProviderStrategy,
} from "../../src/shared/utils/providerStrategySettings.js";

// In-memory stand-in for GET+PATCH /api/settings with a small delay so two
// concurrent patchProviderStrategy calls actually interleave.
function makeServer(initial) {
  const state = { providerStrategies: { ...initial } };
  const bodies = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    await new Promise((r) => setTimeout(r, 5));
    if (options.method === "PATCH") {
      const body = JSON.parse(options.body);
      bodies.push(body);
      state.providerStrategies = { ...body.providerStrategies };
      return Response.json({ ok: true });
    }
    return Response.json({ providerStrategies: { ...state.providerStrategies } });
  });
  return { state, bodies, fetchImpl };
}

describe("patchProviderStrategy concurrency + delete semantics (D12)", () => {
  it("preserves both keys when strategy and scheduler saves interleave", async () => {
    const { state, fetchImpl } = makeServer({});
    await Promise.all([
      patchProviderStrategy(
        "openai",
        (previous) => ({ ...previous, fallbackStrategy: "round-robin" }),
        fetchImpl,
      ),
      patchProviderStrategy(
        "openai",
        (previous) => ({
          ...previous,
          accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1800 },
        }),
        fetchImpl,
      ),
    ]);
    expect(state.providerStrategies.openai).toMatchObject({
      fallbackStrategy: "round-robin",
      accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1800 },
    });
  });

  it("treats an undefined update as a no-op: no PATCH, entry kept", async () => {
    const { state, bodies, fetchImpl } = makeServer({
      openai: { fallbackStrategy: "auto" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const next = await patchProviderStrategy("openai", () => undefined, fetchImpl);
      expect(next).toEqual({ fallbackStrategy: "auto" });
      expect(bodies).toHaveLength(0);
      expect(fetchImpl).toHaveBeenCalledOnce(); // GET only
      expect(state.providerStrategies.openai).toEqual({ fallbackStrategy: "auto" });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("deletes only on the explicit sentinel, not on empty objects from clear flows", async () => {
    const { state, fetchImpl } = makeServer({
      openai: { fallbackStrategy: "auto" },
    });
    await patchProviderStrategy("openai", () => DELETE_PROVIDER_STRATEGY, fetchImpl);
    expect(state.providerStrategies).not.toHaveProperty("openai");
  });
});
