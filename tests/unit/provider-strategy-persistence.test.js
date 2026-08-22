import { expect, it, vi } from "vitest";
import {
  patchProviderStrategy,
} from "../../src/shared/utils/providerStrategySettings.js";

it("performs no PATCH when the settings read fails", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response("failed", { status: 500 }));

  await expect(patchProviderStrategy("anthropic", (previous) => ({
    ...previous,
    accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1_800 },
  }), fetchImpl)).rejects.toThrow("Failed to load settings");

  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("rejects a failed PATCH without reporting a committed next value", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({
      providerStrategies: {
        anthropic: {
          fallbackStrategy: "round-robin",
          stickyRoundRobinLimit: 7,
          unknown: "keep",
        },
        openai: { unknown: "other-provider" },
      },
    }))
    .mockResolvedValueOnce(new Response("failed", { status: 503 }));

  await expect(patchProviderStrategy("anthropic", (previous) => ({
    ...previous,
    accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1_800 },
  }), fetchImpl)).rejects.toThrow("Failed to save settings");

  const patch = JSON.parse(fetchImpl.mock.calls[1][1].body);
  expect(patch.providerStrategies).toEqual({
    anthropic: {
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 7,
      unknown: "keep",
      accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1_800 },
    },
    openai: { unknown: "other-provider" },
  });
});

it("returns the committed provider override only after a successful PATCH", async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ providerStrategies: { anthropic: { unknown: "keep" } } }))
    .mockResolvedValueOnce(Response.json({ ok: true }));

  const next = await patchProviderStrategy("anthropic", (previous) => ({
    ...previous,
    accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 60 },
  }), fetchImpl);

  expect(next).toEqual({
    unknown: "keep",
    accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 60 },
  });
});
