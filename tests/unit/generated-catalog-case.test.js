import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  __resetCatalogCache,
  getGeneratedCapabilities,
  getGeneratedPricing,
} from "../../open-sse/providers/generated/loader.js";
import { buildCatalog } from "../../scripts/fetch-model-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = path.join(ROOT, "open-sse", "providers", "generated", "catalog.json");

describe("generated catalog case handling (E16)", () => {
  it("holds no two keys sharing a lowercase form", () => {
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    for (const section of ["pricing", "capabilities"]) {
      const seen = new Map();
      for (const key of Object.keys(catalog[section] || {})) {
        const lower = key.toLowerCase();
        expect(seen.get(lower), `${section} duplicate casing: ${seen.get(lower)} vs ${key}`).toBeUndefined();
        seen.set(lower, key);
      }
    }
  });

  it("resolves either casing to the same pricing", () => {
    __resetCatalogCache();
    expect(getGeneratedPricing("minimax-m2.7")).toEqual(getGeneratedPricing("MiniMax-M2.7"));
    expect(getGeneratedPricing("kimi-k2.6")).toEqual(getGeneratedPricing("Kimi-K2.6"));
    expect(getGeneratedPricing("deepseek-v4-flash")).toEqual(getGeneratedPricing("DeepSeek-V4-Flash"));
    expect(getGeneratedPricing("minimax-m2.7")).not.toBeNull();
  });

  it("resolves either casing to the same capabilities", () => {
    __resetCatalogCache();
    expect(getGeneratedCapabilities("minimax-m2.7")).toEqual(getGeneratedCapabilities("MiniMax-M2.7"));
    expect(getGeneratedCapabilities("minimax-m2.7")).not.toBeNull();
  });

  it("generator collapses conflicting case-variant keys onto one id (exact key wins)", () => {
    const known = new Set(["MiniMax-M2.7", "minimax-m2.7"]);
    const entry = (ctx, price) => ({
      mode: "chat",
      litellm_provider: "x",
      input_cost_per_token: price,
      output_cost_per_token: price,
      max_input_tokens: ctx,
      max_output_tokens: ctx,
      supports_reasoning: true,
    });
    // Both keys are exact registry ids; sorted order ("M" < "m") picks MiniMax-M2.7.
    const catalog = buildCatalog(
      { "minimax-m2.7": entry(200, 0.000002), "MiniMax-M2.7": entry(100, 0.000001) },
      known,
      []
    );
    expect(Object.keys(catalog.pricing)).toEqual(["MiniMax-M2.7"]);
    expect(catalog.pricing["MiniMax-M2.7"].input).toBe(1);
    expect(catalog.capabilities["MiniMax-M2.7"].contextWindow).toBe(100);
    // A provider-prefixed variant never outranks an exact key, whatever the sort order.
    const prefixed = buildCatalog(
      { "aaa/MiniMax-M2.7": entry(100, 0.000001), "minimax-m2.7": entry(200, 0.000002) },
      known,
      []
    );
    expect(Object.keys(prefixed.pricing)).toEqual(["minimax-m2.7"]);
    expect(prefixed.pricing["minimax-m2.7"].input).toBe(2);
  });

  it("generator dedupes identical case-variant values to one key", () => {
    const known = new Set(["MiniMax-M2.7", "minimax-m2.7"]);
    const entry = {
      mode: "chat",
      litellm_provider: "x",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000001,
      max_input_tokens: 100,
      max_output_tokens: 100,
      supports_reasoning: true,
    };
    const catalog = buildCatalog({ "MiniMax-M2.7": entry, "minimax-m2.7": entry }, known, []);
    expect(Object.keys(catalog.pricing)).toEqual(["MiniMax-M2.7"]);
  });
});
