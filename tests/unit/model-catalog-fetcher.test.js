import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  capabilitiesFromEntry,
  mapCatalogEntry,
  pricingFromEntry,
  resolveOurId,
  stableStringify,
  to1M,
} from "../../scripts/fetch-model-catalog.mjs";

const STANDARD_PRICING = {
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000025,
  cache_read_input_token_cost: 0.0000005,
  cache_creation_input_token_cost: 0.00000625,
};

const CLAUDE_OPUS_4_6 = {
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000025,
  supports_vision: true,
  max_input_tokens: 1000000,
};


describe("model catalog fetcher pricing helpers", () => {
  it("converts finite per-token prices to per-million prices", () => {
    expect(to1M(0.00000125)).toBe(1.25);
    expect(to1M(0.000000125)).toBe(0.125);
    expect(to1M(undefined)).toBeNull();
    expect(to1M(-1)).toBeNull();
    expect(to1M("x")).toBeNull();
  });

  it("extracts standard pricing without inventing reasoning pricing", () => {
    expect(pricingFromEntry(STANDARD_PRICING)).toEqual({
      input: 5,
      output: 25,
      cached: 0.5,
      cache_creation: 6.25,
    });
    expect(pricingFromEntry(STANDARD_PRICING)).not.toHaveProperty("reasoning");
  });

  it("requires both input and output pricing", () => {
    expect(pricingFromEntry({})).toBeNull();
    expect(pricingFromEntry({ input_cost_per_token: 0.000001 })).toBeNull();
  });

  it("returns only input and output when cache fields are absent", () => {
    expect(pricingFromEntry({
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    })).toEqual({ input: 1, output: 2 });
  });
});

describe("model catalog fetcher capability helpers", () => {
  it("extracts explicitly declared capability and token-limit deltas", () => {
    expect(capabilitiesFromEntry({
      supports_vision: true,
      supports_pdf_input: false,
      supports_function_calling: true,
      supports_reasoning: true,
      max_input_tokens: 400000,
      max_output_tokens: 128000,
    })).toEqual({
      vision: true,
      pdf: false,
      tools: true,
      reasoning: true,
      contextWindow: 400000,
      maxOutput: 128000,
    });
  });

  it("returns null for an entry with no capability delta", () => {
    expect(capabilitiesFromEntry({})).toBeNull();
  });

  it("marks image generation as image output", () => {
    expect(capabilitiesFromEntry({ mode: "image_generation" })).toEqual({ imageOutput: true });
  });

  it("uses max_tokens for both limits when dedicated limits are absent", () => {
    expect(capabilitiesFromEntry({ max_tokens: 1000 })).toEqual({
      contextWindow: 1000,
      maxOutput: 1000,
    });
  });
});

describe("model catalog fetcher identity and mapping", () => {
  it("resolves qualified IDs, aliases, and case-insensitive known IDs from Sets", () => {
    expect(resolveOurId(
      "gemini/gemini-2.5-pro",
      new Set(["gemini-2.5-pro"]),
    )).toBe("gemini-2.5-pro");
    expect(resolveOurId(
      "gemini-2.5-pro-preview-06-05",
      new Set(["gemini-2.5-pro"]),
    )).toBe("gemini-2.5-pro");
    expect(resolveOurId("minimax-m3", new Set(["MiniMax-M3"]))).toBe("MiniMax-M3");
  });

  it("does not resolve an unknown ID from an empty Set", () => {
    expect(resolveOurId("totally-unknown-xyz", new Set())).toBeNull();
  });

  it("never maps excluded generic ids like LiteLLM's OpenRouter 'auto'", () => {
    expect(resolveOurId("auto", new Set(["auto"]))).toBeNull();
    expect(resolveOurId("openrouter/auto", new Set(["auto"]))).toBeNull();
  });

  it("maps the exact known Claude fixture and rejects unknown or empty records", () => {
    const knownIds = new Set(["claude-opus-4-6"]);

    expect(mapCatalogEntry("claude-opus-4-6", CLAUDE_OPUS_4_6, knownIds)).toEqual({
      id: "claude-opus-4-6",
      pricing: { input: 5, output: 25 },
      capabilities: { vision: true, contextWindow: 1000000 },
    });
    expect(mapCatalogEntry("totally-unknown-xyz", CLAUDE_OPUS_4_6, new Set())).toBeNull();
    expect(mapCatalogEntry("claude-opus-4-6", {}, knownIds)).toBeNull();
  });
});

describe("model catalog fetcher catalog construction", () => {
  it("keeps a known chat model and excludes unknown chat and known embedding models", () => {
    const catalog = buildCatalog({
      "claude-opus-4-6": { ...CLAUDE_OPUS_4_6, litellm_provider: "anthropic" },
      "totally-unknown-xyz": { ...CLAUDE_OPUS_4_6, litellm_provider: "anthropic" },
      "text-embedding-3-small": {
        ...CLAUDE_OPUS_4_6,
        litellm_provider: "openai",
        mode: "embedding",
      },
    }, new Set(["claude-opus-4-6", "text-embedding-3-small"]), new Set(["anthropic", "openai"]), "FIXED");

    expect(catalog.fetchedAt).toBe("FIXED");
    expect(catalog.pricing).toEqual({ "claude-opus-4-6": { input: 5, output: 25 } });
    expect(catalog.capabilities).toEqual({
      "claude-opus-4-6": { vision: true, contextWindow: 1000000 },
    });
  });

  it("keeps the alphabetically first price when aliases resolve to one ID", () => {
    const catalog = buildCatalog({
      "gemini-2.5-pro-preview-06-05": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000004,
      },
      "gemini-2.5-pro": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    }, new Set(["gemini-2.5-pro"]), new Set());

    expect(catalog.pricing["gemini-2.5-pro"]).toEqual({ input: 1, output: 2 });
  });

  it("prefers the exact canonical key over an earlier-sorting prefixed variant", () => {
    const catalog = buildCatalog({
      "azure/gpt-5": {
        input_cost_per_token: 0.000009,
        output_cost_per_token: 0.000011,
      },
      "gpt-5": {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
      },
    }, new Set(["gpt-5"]), new Set());

    expect(catalog.pricing["gpt-5"]).toEqual({ input: 1.25, output: 10 });
  });

  it("defaults fetchedAt to null", () => {
    expect(buildCatalog({}, new Set(), new Set()).fetchedAt).toBeNull();
  });
});

describe("model catalog fetcher stable serialization", () => {
  it("sorts the exact fixture recursively while preserving array order", () => {
    const fixture = { b: 1, a: { d: 2, c: [3, 1] } };
    const serialized = stableStringify(fixture);
    const parsed = JSON.parse(serialized);

    expect(parsed).toEqual(fixture);
    expect(Object.keys(parsed)).toEqual(["a", "b"]);
    expect(Object.keys(parsed.a)).toEqual(["c", "d"]);
    expect(parsed.a.c).toEqual([3, 1]);
    expect(serialized.indexOf('"a"')).toBeLessThan(serialized.indexOf('"b"'));
    expect(serialized).toContain("\n  ");
    expect(serialized).toBe([
      "{",
      '  "a": {',
      '    "c": [',
      "      3,",
      "      1",
      "    ],",
      '    "d": 2',
      "  },",
      '  "b": 1',
      "}",
    ].join("\n"));
    expect(stableStringify(fixture)).toBe(serialized);
    expect(serialized.endsWith("\n")).toBe(false);
  });
});
