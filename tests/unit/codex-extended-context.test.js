import { describe, expect, it } from "vitest";
import codex from "../../open-sse/providers/registry/codex.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";

// Ported from upstream 9f41ee75 (tests/unit/codex-extended-context.mjs).
describe("Codex [1m] extended-context variants", () => {
  it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])("%s[1m] maps to its base model with 872k", async (id) => {
    const extended = `${id}[1m]`;
    expect(codex.models.find((model) => model.id === extended)?.upstreamModelId).toBe(id);
    expect(getModelUpstreamId("cx", extended)).toBe(id);
    expect(getCapabilitiesForModel("codex", extended).contextWindow).toBe(872000);
    expect(getCapabilitiesForModel("cx", extended).contextWindow).toBe(872000);
    expect(await getModelInfoCore(`cx/${extended}`, {})).toEqual({ provider: "codex", model: extended });
  });

  it("keeps the default Codex window for the base 5.6 models", () => {
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel("codex", "gpt-5.6-terra").contextWindow).toBe(272000);
  });
});

describe("Codex unsupported-model account fallback", () => {
  const unsupported = "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.";
  it("falls back to another Codex account", () => {
    expect(checkFallbackError(400, unsupported, 0, "codex").shouldFallback).toBe(true);
    expect(checkFallbackError(400, "Invalid JSON body", 0, "codex").shouldFallback).toBe(false);
  });
  it("does not apply the codex-scoped rule to other providers", () => {
    expect(checkFallbackError(400, unsupported, 0, "openai").cooldownMs).not.toBe(24 * 60 * 60 * 1000);
  });
});
