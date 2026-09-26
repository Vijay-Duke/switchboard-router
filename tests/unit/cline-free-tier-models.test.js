// Cline's free tier lives in the `cline-free/` namespace. The vendor-prefix
// strip in getPricingForModel() would otherwise price
// "cline-free/deepseek-v4.1-flash" as the paid "deepseek-v4.1-flash".

import { describe, it, expect } from "vitest";
import { getPricingForModel, calculateCostFromTokens, isFreeModel } from "../../open-sse/providers/pricing.js";

describe("cline-free namespace pricing", () => {
  it("bills cline-free/* at zero", () => {
    expect(getPricingForModel("cline", "cline-free/deepseek-v4.1-flash")).toMatchObject({
      input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0,
    });
    expect(getPricingForModel("cline", "cline-free/muse-spark-1.3-contributor").input).toBe(0);
  });

  it("still bills the paid twin through the normal chain", () => {
    expect(isFreeModel("deepseek/deepseek-v4.1-flash")).toBe(false);
    const paid = getPricingForModel("cline", "deepseek/deepseek-v4-pro");
    expect(paid?.input).toBeGreaterThan(0);
  });

  it("zero price survives cost calculation over a large usage", () => {
    const pricing = getPricingForModel("cline", "cline-free/deepseek-v4.1-flash");
    const cost = calculateCostFromTokens(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, reasoning_tokens: 500_000 },
      pricing
    );
    expect(cost).toBe(0);
  });
});
