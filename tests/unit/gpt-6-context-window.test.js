import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Ported from upstream 89ffac5a (devin-cli and catalog-sync cases dropped —
// neither exists in Switchboard). The gpt-6 family's API window is 1.05M; the
// pattern table published a gateway's 272k, so every other provider's gpt-6
// models were advertised far under their real window.
const API_WINDOW = 1050000;
const LEGACY_GPT5_WINDOW = 400000;

describe("gpt-6 / gpt-5.4+ context windows", () => {
  it("reports the 1.05M API window for gpt-6 models on ordinary providers", () => {
    for (const [provider, model] of [
      ["github", "gpt-6-luna"],
      ["azure", "gpt-6-luna"],
      ["openai", "gpt-6-luna"],
      ["github", "gpt-6-sol"],
      ["openai", "gpt-6-astra"],
    ]) {
      expect(getCapabilitiesForModel(provider, model).contextWindow, `${provider}/${model}`).toBe(API_WINDOW);
    }
  });

  it("leaves Codex OAuth on its own truncated windows", () => {
    expect(getCapabilitiesForModel("codex", "gpt-5.6-luna").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra").contextWindow).toBe(500000);
  });

  it("splits the 1.05M tiers from the 400k ones", () => {
    for (const model of [
      "gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-terra",
    ]) {
      expect(getCapabilitiesForModel("openai", model).contextWindow, model).toBe(API_WINDOW);
    }
    for (const model of ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.3-codex"]) {
      expect(getCapabilitiesForModel("openai", model).contextWindow, model).toBe(LEGACY_GPT5_WINDOW);
    }
  });

  it("keeps gpt image variants as image models", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-sol-image").imageOutput).toBe(true);
  });
});
