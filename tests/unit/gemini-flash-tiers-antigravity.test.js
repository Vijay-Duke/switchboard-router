import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import gemini from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

const require = createRequire(import.meta.url);
const { resolveTieredModel, MODEL_SYNONYMS } = require("../../src/mitm/config.js");

const TIERS = ["high", "medium", "low"];
const WIRE = {
  "3.8": (tier) => `gemini-3.8-flash-${tier}`,
  "3.7": () => "gemini-3.7-flash-tiered",
  "3.6": () => "gemini-3.6-flash-tiered",
};

function buildWireBody(publicModel) {
  const upstreamModel = getModelUpstreamId("ag", publicModel);
  const body = {
    model: stripThinkingSuffix(upstreamModel),
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: {} },
  };
  applyThinking("antigravity", upstreamModel, body, "antigravity");
  return new AntigravityExecutor().transformRequest(publicModel, body, true, { projectId: "project", connectionId: "c" });
}

describe("Antigravity Gemini Flash tiers", () => {
  for (const [ver, wire] of Object.entries(WIRE)) {
    it.each(TIERS)(`maps gemini-${ver}-flash-%s to its wire model and thinking level`, (tier) => {
      const finalBody = buildWireBody(`gemini-${ver}-flash-${tier}`);
      expect(finalBody.model).toBe(wire(tier));
      expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: tier, includeThoughts: true });
    });
  }

  it("routes untiered gemini-3.8-flash to the medium tier", () => {
    const finalBody = buildWireBody("gemini-3.8-flash");
    expect(finalBody.model).toBe("gemini-3.8-flash-medium");
    expect(finalBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });

  it("maps gemini-3.1-pro-high onto the gemini-pro-agent wire model", () => {
    expect(buildWireBody("gemini-3.1-pro-high").model).toBe("gemini-pro-agent");
  });
});

describe("Antigravity MITM tiered model extraction", () => {
  it.each([["3.7"], ["3.6"]])("resolves gemini-%s-flash-tiered by thinkingLevel", (ver) => {
    for (const tier of TIERS) {
      const parsed = { request: { generationConfig: { thinkingConfig: { thinkingLevel: tier.toUpperCase() } } } };
      expect(resolveTieredModel(`models/gemini-${ver}-flash-tiered`, parsed)).toBe(`gemini-${ver}-flash-${tier}`);
    }
  });

  it("defaults a missing or unknown thinking level to medium", () => {
    expect(resolveTieredModel("gemini-3.7-flash-tiered", { request: { generationConfig: { thinkingConfig: { thinkingLevel: "x" } } } }))
      .toBe("gemini-3.7-flash-medium");
    expect(resolveTieredModel("gemini-3.6-flash-tiered", {})).toBe("gemini-3.6-flash-medium");
  });

  it("leaves non-tiered models untouched", () => {
    expect(resolveTieredModel("gemini-3.5-flash-low", {})).toBe("gemini-3.5-flash-low");
    expect(resolveTieredModel(null, {})).toBeNull();
  });

  it("normalizes gemini-3.8-flash to its medium tier", () => {
    expect(MODEL_SYNONYMS.antigravity["gemini-3.8-flash"]).toBe("gemini-3.8-flash-medium");
  });
});

describe("Gemini Flash tier catalog", () => {
  it("lists every tier in the MITM defaultModels and aliases", () => {
    const ag = MITM_TOOLS.antigravity;
    const ids = ag.defaultModels.map((m) => m.id);
    for (const ver of Object.keys(WIRE)) {
      for (const tier of TIERS) {
        expect(ids).toContain(`gemini-${ver}-flash-${tier}`);
        expect(ag.modelAliases).toContain(`gemini-${ver}-flash-${tier}`);
      }
    }
  });

  it("exposes direct Gemini API models with pricing", () => {
    const ids = gemini.models.map((m) => m.id);
    for (const ver of Object.keys(WIRE)) {
      expect(ids).toContain(`gemini-${ver}-flash`);
      expect(MODEL_PRICING[`gemini-${ver}-flash`]).toMatchObject({ input: 1.5, output: 7.5 });
    }
  });
});
