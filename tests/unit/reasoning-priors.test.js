// Unified thinking metadata (P0+P1): levels must come from data — live
// upstream catalogs and the synced models.dev/OpenRouter priors — not from
// per-family hand-coded lists. GLM-5.3 is the regression case: the registry
// called ZAI binary, so /v1/models advertised no effort at all, while every
// external source lists low/high/max.
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReasoningCatalog,
  mergeReasoningIntoCatalog,
} from "../../scripts/fetch-reasoning-catalog.mjs";
import {
  lookupReasoningPrior,
  __setReasoningPriorsForTests,
} from "../../open-sse/providers/reasoningPriors.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveEffortCapabilities } from "../../open-sse/providers/capabilities.js";

const modelsDevFixture = {
  zai: { models: {
    "glm-5.3": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    "glm-4.6": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
    "glm-4v": { reasoning: false },
  } },
  opencode: { models: {
    "glm-5.3": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    "deepseek-v4-pro": { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["high", "max"] }] },
  } },
  anthropic: { models: {
    "claude-haiku-4-5": { reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32000 }] },
  } },
};

const openRouterFixture = {
  data: [
    { id: "z-ai/glm-5.3", reasoning: { mandatory: true, default_effort: "max", supported_efforts: ["max", "high", "low"] } },
    { id: "z-ai/glm-5.3:batch", reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] } },
    { id: "acme/new-model-1", reasoning: { mandatory: false, default_effort: "high", supported_efforts: ["high", "low", "none"] } },
    { id: "acme/plain-1", supported_parameters: ["temperature"] },
  ],
};

describe("buildReasoningCatalog", () => {
  it("builds bare consensus + provider entries from models.dev", () => {
    const { reasoning } = buildReasoningCatalog({ modelsDev: modelsDevFixture, openRouter: null });
    expect(reasoning["glm-5.3"]).toEqual({ levels: ["low", "high", "max"] });
    expect(reasoning["deepseek-v4-pro"]).toEqual({ levels: ["high", "max"] });
  });

  it("records toggle-only and budget-only models without inventing levels", () => {
    const { reasoning } = buildReasoningCatalog({ modelsDev: modelsDevFixture, openRouter: null });
    expect(reasoning["glm-4.6"]).toEqual({ toggle: true });
    expect(reasoning["claude-haiku-4-5"]).toEqual({ budget: { min: 1024, max: 32000 } });
    expect(reasoning["glm-4v"]).toBeUndefined();
  });

  it("fills mandatory/default from OpenRouter and covers models models.dev lacks", () => {
    const { reasoning } = buildReasoningCatalog({ modelsDev: modelsDevFixture, openRouter: openRouterFixture });
    expect(reasoning["glm-5.3"]).toEqual({ levels: ["low", "high", "max"], mandatory: true, default: "max" });
    expect(reasoning["new-model-1"]).toEqual({ levels: ["low", "high"], default: "high" });
    expect(reasoning["plain-1"]).toBeUndefined();
  });

  it("keeps provider-qualified entries only when they differ from bare consensus", () => {
    const dev = {
      aaa: { models: { "m1": { reasoning: true, reasoning_options: [{ type: "effort", values: ["high", "max"] }] } } },
      bbb: { models: { "m1": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } } },
      ccc: { models: { "m1": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } } },
    };
    const { reasoning } = buildReasoningCatalog({ modelsDev: dev, openRouter: null });
    expect(reasoning["m1"]).toEqual({ levels: ["low", "high", "max"] });
    expect(reasoning["aaa/m1"]).toEqual({ levels: ["high", "max"] });
    expect(reasoning["bbb/m1"]).toBeUndefined();
  });

  it("mergeReasoningIntoCatalog preserves pricing/capabilities sections", () => {
    const existing = { fetchedAt: "x", pricing: { a: 1 }, capabilities: { b: 2 } };
    const merged = mergeReasoningIntoCatalog(existing, { "glm-5.3": { levels: ["low"] } });
    expect(merged.pricing).toEqual({ a: 1 });
    expect(merged.reasoning).toEqual({ "glm-5.3": { levels: ["low"] } });
  });
});

describe("lookupReasoningPrior", () => {
  const map = {
    "glm-5.3": { levels: ["low", "high", "max"] },
    "zai/glm-5.3": { levels: ["low", "high", "max"], mandatory: true },
    "deepseek-v4-pro": { levels: ["high", "max"] },
  };

  it("resolves provider aliases (glm → zai) before bare consensus", () => {
    expect(lookupReasoningPrior(map, "glm", "glm-5.3")).toEqual({ levels: ["low", "high", "max"], mandatory: true });
  });

  it("falls back to bare consensus for gateway-prefixed ids", () => {
    expect(lookupReasoningPrior(map, "command-code", "zai-org/GLM-5.3")).toEqual({ levels: ["low", "high", "max"] });
    expect(lookupReasoningPrior(map, "opencode", "deepseek-v4-pro")).toEqual({ levels: ["high", "max"] });
  });

  it("returns null for unknown models", () => {
    expect(lookupReasoningPrior(map, "zzz", "nope-1")).toBeNull();
    expect(lookupReasoningPrior(null, "glm", "glm-5.3")).toBeNull();
  });
});

describe("getThinkingLevels with catalog priors", () => {
  afterEach(() => __setReasoningPriorsForTests(null));

  it("keeps binary ZAI levels when no prior exists (today's behavior)", () => {
    __setReasoningPriorsForTests({});
    expect(getThinkingLevels("zai", "glm-5.3")).toEqual(["none", "thinking"]);
  });

  it("upgrades binary formats from the catalog prior", () => {
    __setReasoningPriorsForTests({ "glm-5.3": { levels: ["low", "high", "max"] } });
    expect(getThinkingLevels("zai", "glm-5.3")).toEqual(["none", "low", "high", "max"]);
  });

  it("drops 'none' when the prior says reasoning is mandatory", () => {
    __setReasoningPriorsForTests({ "glm-5.3": { levels: ["low", "high", "max"], mandatory: true } });
    expect(getThinkingLevels("zai", "glm-5.3")).toEqual(["low", "high", "max"]);
  });

  it("does not override budget-mapped base formats (qwen) with priors", () => {
    // Qwen levels drive thinking_budget fractions in the translator;
    // swapping the vocabulary would silently change sent budgets.
    __setReasoningPriorsForTests({ "qwen3.8-max": { levels: ["low", "high", "max"] } });
    expect(getThinkingLevels(null, "qwen3.8-max")).toEqual(["none", "low", "medium", "high"]);
  });

  it("does not override rich curated formats (openai) with priors", () => {
    __setReasoningPriorsForTests({ "gpt-5.2": { levels: ["low", "high"] } });
    expect(getThinkingLevels(null, "gpt-5.2")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("resolveEffortCapabilities live-dialect synthesis (P0)", () => {
  const on = { supported: true };

  it("synthesizes an effort block from upstream reasoning.effort[]", () => {
    const up = { reasoning: { supported: true, effort: ["low", "high", "max"] } };
    expect(resolveEffortCapabilities(up, null)).toEqual({
      effort: { supported: true, low: on, high: on, max: on },
    });
  });

  it("synthesizes from OpenRouter supported_efforts and drops 'none' as a level", () => {
    const up = { reasoning: { supported_efforts: ["max", "high", "none"] } };
    expect(resolveEffortCapabilities(up, null)).toEqual({
      effort: { supported: true, high: on, max: on },
    });
  });

  it("intersects synthesized levels with the static allow-list", () => {
    const up = { reasoning: { effort: ["low", "high", "max"] } };
    const st = { effort: { supported: true, high: on, max: on } };
    expect(resolveEffortCapabilities(up, st)).toEqual({
      effort: { supported: true, high: on, max: on },
    });
  });

  it("ignores reasoning blocks without a level list", () => {
    expect(resolveEffortCapabilities({ reasoning: { supported: true } }, null)).toBeNull();
    expect(resolveEffortCapabilities({ reasoning: { effort: "high" } }, null)).toBeNull();
  });

  it("explicit effort ban still wins over a synthesized list", () => {
    const up = { effort: { supported: false }, reasoning: { effort: ["high"] } };
    expect(resolveEffortCapabilities(up, null)).toEqual({ effort: { supported: false } });
  });
});
