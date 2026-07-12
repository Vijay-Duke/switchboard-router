import { describe, it, expect, vi } from "vitest";

vi.mock("../../open-sse/providers/generated/loader.js", () => {
  const genPricing = { "gpt-5": { input: 999, output: 111, cached: 1, reasoning: 111, cache_creation: 2 } };
  const genCaps = {
    "gpt-5": { vision: false, pdf: true, videoInput: true },
    "some-unknown-model-xyz": { vision: true, contextWindow: 123456 },
  };
  return {
    readCatalogFile: () => ({ pricing: genPricing, capabilities: genCaps }),
    getGeneratedCatalog: () => ({ pricing: genPricing, capabilities: genCaps }),
    __resetCatalogCache: () => {},
    getGeneratedPricing: (m) => genPricing[m] || null,
    getGeneratedCapabilities: (m) => genCaps[m] || null,
  };
});

import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("generated catalog merging", () => {
  it("uses generated pricing over hand-maintained pricing", () => {
    expect(getPricingForModel(null, "gpt-5")?.input).toBe(999);
  });

  it("keeps explicit provider pricing over generated pricing", () => {
    expect(getPricingForModel("gh", "gpt-5.3-codex")?.input).toBe(1.75);
  });

  it("returns null for unknown pricing", () => {
    expect(getPricingForModel("openai", "totally-made-up-000")).toBeNull();
  });

  it("preserves generated capabilities for otherwise unknown models", () => {
    const caps = getCapabilitiesForModel(null, "some-unknown-model-xyz");

    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(123456);
  });

  it("keeps hand-authored capabilities over generated values", () => {
    const caps = getCapabilitiesForModel(null, "gpt-5");

    expect(caps.vision).toBe(true);
    expect(caps.pdf).toBe(true);
    expect(caps.videoInput).toBe(true);
    expect(typeof caps.audioOutput).toBe("boolean");
  });
});
