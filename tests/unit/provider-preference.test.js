import { beforeEach, describe, expect, it } from "vitest";

import {
  orderModelsByProvider,
  providerOf,
  resetProviderRotation,
} from "../../open-sse/routing/providerPreference.js";
import { providerBiasRank, rankByObjective } from "../../open-sse/routing/objective.js";

describe("provider preference ordering", () => {
  beforeEach(() => {
    resetProviderRotation();
  });

  it("extracts the provider from a model id", () => {
    expect(providerOf("openai/gpt-4o")).toBe("openai");
    expect(providerOf("local-model")).toBe("local-model");
  });

  it("orders priority providers and preserves provider-local order", () => {
    const models = ["openai/a", "anthropic/b", "openai/c", "google/d", "mistral/e"];
    expect(orderModelsByProvider(models, {
      strategy: "priority",
      providerOrder: ["anthropic", "openai"],
    })).toEqual([
      "anthropic/b",
      "openai/a",
      "openai/c",
      "google/d",
      "mistral/e",
    ]);
  });

  it("prefers faster providers", () => {
    const models = ["anthropic/a", "openai/b", "anthropic/c"];
    expect(orderModelsByProvider(models, {
      strategy: "fastest",
      providerLatencyMs: { openai: 100, anthropic: 500 },
    })).toEqual(["openai/b", "anthropic/a", "anthropic/c"]);
  });

  it("prefers providers with fewer recent requests", () => {
    const models = ["openai/a", "anthropic/b", "openai/c"];
    expect(orderModelsByProvider(models, {
      strategy: "quota-first",
      providerUsage: { openai: 1000, anthropic: 10 },
    })).toEqual(["anthropic/b", "openai/a", "openai/c"]);
  });

  it("prefers quota-known providers with more remaining headroom", () => {
    const models = ["openai/a", "anthropic/b"];
    expect(orderModelsByProvider(models, {
      strategy: "quota-first",
      providerQuota: { anthropic: 80, openai: 20 },
    })).toEqual(["anthropic/b", "openai/a"]);
  });

  it("places quota-known providers before availability-ranked providers", () => {
    const models = ["openai/a", "anthropic/b"];
    expect(orderModelsByProvider(models, {
      strategy: "quota-first",
      providerQuota: { anthropic: 10 },
      providerUsage: { openai: 5 },
    })).toEqual(["anthropic/b", "openai/a"]);
  });

  it("uses availability ranking when quota snapshots are absent", () => {
    const models = ["openai/a", "anthropic/b"];
    expect(orderModelsByProvider(models, {
      strategy: "quota-first",
      providerQuota: { google: 80 },
      providerUsage: { openai: 20, anthropic: 5 },
    })).toEqual(["anthropic/b", "openai/a"]);
  });

  it("demotes slow providers even when priority would put them first", () => {
    const models = ["slow/a", "fast/b", "slow/c"];
    expect(orderModelsByProvider(models, {
      strategy: "priority",
      providerOrder: ["slow", "fast"],
      providerLatencyMs: { fast: 100, slow: 30000 },
      guardMs: 20000,
    })).toEqual(["fast/b", "slow/a", "slow/c"]);
  });

  it("leaves off and short model lists unchanged", () => {
    const models = ["openai/a", "anthropic/b"];
    expect(orderModelsByProvider(models, { strategy: "off" })).toBe(models);

    const single = ["openai/a"];
    expect(orderModelsByProvider(single, { strategy: "priority" })).toBe(single);
  });

  it("never drops models", () => {
    const models = ["openai/a", "anthropic/b", "openai/a", "google/c"];
    const ordered = orderModelsByProvider(models, {
      strategy: "priority",
      providerOrder: ["google", "anthropic", "openai"],
    });
    expect(ordered).toHaveLength(models.length);
    expect([...ordered].sort()).toEqual([...models].sort());
  });

  it("rotates the starting provider and resets by key", () => {
    const models = ["openai/a", "anthropic/b", "openai/c"];
    const first = orderModelsByProvider(models, {
      strategy: "round-robin",
      rotationKey: "combo-a",
    });
    const second = orderModelsByProvider(models, {
      strategy: "round-robin",
      rotationKey: "combo-a",
    });
    expect(providerOf(first[0])).not.toBe(providerOf(second[0]));

    resetProviderRotation();
    const reset = orderModelsByProvider(models, {
      strategy: "round-robin",
      rotationKey: "combo-a",
    });
    expect(reset[0]).toBe(first[0]);
  });
});

describe("Auto provider bias", () => {
  it("ranks priority, fastest, quota-first, and guarded providers", () => {
    expect(providerBiasRank("openai/a", { strategy: "off" })).toBe(0);
    expect(providerBiasRank("anthropic/a", {
      strategy: "priority",
      providerOrder: ["anthropic", "openai"],
    })).toBeLessThan(providerBiasRank("openai/a", {
      strategy: "priority",
      providerOrder: ["anthropic", "openai"],
    }));
    expect(providerBiasRank("openai/a", {
      strategy: "fastest",
      providerLatencyMs: { openai: 100, anthropic: 500 },
    })).toBeLessThan(providerBiasRank("anthropic/a", {
      strategy: "fastest",
      providerLatencyMs: { openai: 100, anthropic: 500 },
    }));
    expect(providerBiasRank("anthropic/a", {
      strategy: "quota-first",
      providerUsage: { openai: 100, anthropic: 10 },
    })).toBeLessThan(providerBiasRank("openai/a", {
      strategy: "quota-first",
      providerUsage: { openai: 100, anthropic: 10 },
    }));
    expect(providerBiasRank("slow/a", {
      strategy: "priority",
      providerOrder: ["slow", "fast"],
      providerLatencyMs: { slow: 30000, fast: 100 },
      guardMs: 20000,
    })).toBeGreaterThan(providerBiasRank("fast/a", {
      strategy: "priority",
      providerOrder: ["slow", "fast"],
      providerLatencyMs: { slow: 30000, fast: 100 },
      guardMs: 20000,
    }));
  });

  it("uses quota headroom before availability usage", () => {
    expect(providerBiasRank("anthropic/a", {
      strategy: "quota-first",
      providerQuota: { anthropic: 10 },
      providerUsage: { openai: 0 },
    })).toBeLessThan(providerBiasRank("openai/a", {
      strategy: "quota-first",
      providerUsage: { openai: 0 },
    }));
  });

  it("only reorders provider preference within 15 score points", () => {
    const bias = { strategy: "priority", providerOrder: ["anthropic", "openai"] };
    const tied = rankByObjective([
      { id: "openai/a", avgScore: 80 },
      { id: "anthropic/b", avgScore: 70 },
    ], "quality", { providerBias: bias });
    expect(tied.map((entry) => entry.id)).toEqual(["anthropic/b", "openai/a"]);

    const clearWinner = rankByObjective([
      { id: "openai/a", avgScore: 80 },
      { id: "anthropic/b", avgScore: 64 },
    ], "quality", { providerBias: bias });
    expect(clearWinner.map((entry) => entry.id)).toEqual(["openai/a", "anthropic/b"]);
  });
});
