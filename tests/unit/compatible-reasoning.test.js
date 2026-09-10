// Unit tests for per-model reasoning wire-format mapping on OpenAI-compatible
// nodes: catalog normalization (reasoningCatalog.js), static host defaults,
// the thinkingUnified resolver hook, import capture, and the pi catalog sync.
import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeReasoningSupport,
  isValidReasoningSupport,
  staticNodeReasoningDefault,
} from "../../src/shared/utils/reasoningCatalog.js";
import {
  applyThinking,
  setCompatibleThinkingResolver,
} from "../../open-sse/translator/concerns/thinkingUnified.js";
import { normalizeImportedModel } from "../../src/shared/utils/importProviderModels.js";
import { buildPiModelEntries } from "../../src/lib/cli/modelCatalog.js";

afterEach(() => {
  setCompatibleThinkingResolver(null);
});

describe("normalizeReasoningSupport (catalog shapes)", () => {
  it("Surplus Intelligence flat-only model", () => {
    expect(
      normalizeReasoningSupport({
        id: "kimi-k3",
        supported_parameters: ["include_reasoning", "reasoning", "reasoning_effort"],
      }),
    ).toEqual({ supported: true, effort: "flat" });
  });

  it("Surplus Intelligence nested-only model prefers the declared spelling", () => {
    expect(
      normalizeReasoningSupport({
        id: "deepseek-v4-pro",
        supported_parameters: ["include_reasoning", "reasoning"],
      }),
    ).toEqual({ supported: true, effort: "nested" });
  });

  it("supported_parameters without reasoning keys → unsupported", () => {
    expect(
      normalizeReasoningSupport({ id: "x", supported_parameters: ["max_tokens", "temperature"] }),
    ).toEqual({ supported: false, effort: null });
  });

  it("ZENMux capabilities.reasoning", () => {
    expect(normalizeReasoningSupport({ id: "x", capabilities: { reasoning: true } }))
      .toEqual({ supported: true, effort: "flat" });
    expect(normalizeReasoningSupport({ id: "x", capabilities: { reasoning: false } }))
      .toEqual({ supported: false, effort: null });
  });

  it("CrofAI per-model reasoning_effort flag", () => {
    expect(normalizeReasoningSupport({ id: "x", reasoning_effort: true }))
      .toEqual({ supported: true, effort: "flat" });
    expect(normalizeReasoningSupport({ id: "greg-2-ultra", custom_reasoning: false }))
      .toEqual(null);
  });

  it("no signal at all → null (unknown; caller falls back)", () => {
    expect(normalizeReasoningSupport({ id: "x", context_length: 128000 })).toEqual(null);
    expect(normalizeReasoningSupport("gpt-4o")).toEqual(null);
    expect(normalizeReasoningSupport(null)).toEqual(null);
  });
});

describe("staticNodeReasoningDefault (host seeds)", () => {
  it("DashScope compatible-mode hosts (incl. token-plan subdomain) → qwen", () => {
    expect(staticNodeReasoningDefault("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"))
      .toBe("qwen");
    expect(staticNodeReasoningDefault("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"))
      .toBe("qwen");
  });

  it("opencode Zen/Go → flat (thinking objects 400 there)", () => {
    expect(staticNodeReasoningDefault("https://opencode.ai/zen/go/v1/")).toBe("flat");
  });

  it("Surplus Intelligence fallback → flat; Nous Hermes → none", () => {
    expect(staticNodeReasoningDefault("https://api.surplusintelligence.ai/v1")).toBe("flat");
    expect(staticNodeReasoningDefault("https://inference-api.nousresearch.com/v1")).toBe("none");
  });

  it("unknown host → null; garbage → null", () => {
    expect(staticNodeReasoningDefault("https://example.com/v1")).toBe(null);
    expect(staticNodeReasoningDefault("not a url")).toBe(null);
    expect(staticNodeReasoningDefault("")).toBe(null);
  });
});

describe("isValidReasoningSupport", () => {
  it("accepts the documented shapes and rejects junk", () => {
    expect(isValidReasoningSupport({ supported: true, effort: "flat" })).toBe(true);
    expect(isValidReasoningSupport({ supported: false, effort: null })).toBe(true);
    expect(isValidReasoningSupport({ supported: "yes" })).toBe(false);
    expect(isValidReasoningSupport({ supported: true, effort: "qwen" })).toBe(false);
    expect(isValidReasoningSupport(null)).toBe(false);
    expect(isValidReasoningSupport([{ supported: true }])).toBe(false);
  });
});

const COMPAT = "openai-compatible-chat-00000000-0000-0000-0000-000000000000";

describe("thinkingUnified compatible-node resolver hook", () => {
  const apply = (provider, model, body, targetFormat = "openai") => {
    const b = JSON.parse(JSON.stringify(body));
    applyThinking(targetFormat, model, b, provider);
    return b;
  };
  const withEffort = { model: "x", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };

  it("nested format emits reasoning:{effort} (Surplus deepseek-v4-pro)", () => {
    setCompatibleThinkingResolver(() => "openai-nested");
    const b = apply(COMPAT, "deepseek-v4-pro", withEffort);
    expect(b.reasoning).toEqual({ effort: "high" });
    expect(b.thinking).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  it("responses nodes emit reasoning:{effort,summary}", () => {
    setCompatibleThinkingResolver(() => "openai-responses");
    const b = apply("openai-compatible-responses-00000000-0000-0000-0000-000000000000", "gpt-5.6", withEffort, "openai-responses");
    expect(b.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("qwen default emits enable_thinking (DashScope)", () => {
    setCompatibleThinkingResolver(() => "qwen");
    const b = apply(COMPAT, "qwen3.8-max", withEffort);
    expect(b.enable_thinking).toBe(true);
    expect(b.reasoning_effort).toBeUndefined();
  });

  it('"none" strips thinking even when the name pattern claims reasoning', () => {
    setCompatibleThinkingResolver(() => "none");
    const b = apply(COMPAT, "deepseek-v4-pro", withEffort);
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.thinking).toBeUndefined();
    expect(b.reasoning).toBeUndefined();
  });

  it("resolver outranks a false caps.reasoning (CrofAI gemma case)", () => {
    setCompatibleThinkingResolver(() => "openai");
    // gemma pattern has no reasoning flag — static caps would strip; the
    // discovered catalog says flat reasoning_effort is supported.
    const b = apply(COMPAT, "gemma-4-31b-it", withEffort);
    expect(b.reasoning_effort).toBe("high");
  });

  it("null from the resolver falls through to name patterns (today's behavior)", () => {
    setCompatibleThinkingResolver(() => null);
    const b = apply(COMPAT, "deepseek-v4-pro", withEffort);
    expect(b.thinking).toEqual({ type: "enabled" });
    expect(b.reasoning_effort).toBe("high");
  });

  it("hook is ignored for non-compatible providers", () => {
    let called = false;
    setCompatibleThinkingResolver(() => { called = true; return "openai-nested"; });
    const b = apply("glm", "glm-5.3", withEffort);
    expect(called).toBe(false);
    expect(b.thinking).toEqual({ type: "enabled" }); // zai pattern
  });

  it("no client intent → body untouched under the hook", () => {
    setCompatibleThinkingResolver(() => "openai-nested");
    const b = apply(COMPAT, "deepseek-v4-pro", { model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(b.reasoning).toBeUndefined();
  });

  it('"none" intent on nested disables via enabled:false', () => {
    setCompatibleThinkingResolver(() => "openai-nested");
    const b = apply(COMPAT, "deepseek-v4-pro", { ...withEffort, reasoning_effort: "none" });
    expect(b.reasoning).toEqual({ enabled: false });
  });

  it("clamps max→xhigh on the nested wire", () => {
    setCompatibleThinkingResolver(() => "openai-nested");
    const b = apply(COMPAT, "deepseek-v4-pro", { ...withEffort, reasoning_effort: "max" });
    expect(b.reasoning).toEqual({ effort: "xhigh" });
  });
});

describe("import capture", () => {
  it("normalizeImportedModel carries the reasoning descriptor", () => {
    const out = normalizeImportedModel({
      id: "kimi-k3",
      supported_parameters: ["reasoning", "reasoning_effort"],
    }, "surplusintelligence");
    expect(out.reasoning).toEqual({ supported: true, effort: "flat" });
  });

  it("normalizeImportedModel omits reasoning when the catalog is silent", () => {
    const out = normalizeImportedModel({ id: "some-model" }, "lm-studio");
    expect(out.reasoning).toBeUndefined();
  });

  it("string models never carry reasoning", () => {
    const out = normalizeImportedModel("gpt-4o", "any");
    expect(out.reasoning).toBeUndefined();
  });
});

describe("buildPiModelEntries caps resolver", () => {
  it("seeds reasoning/contextWindow for new entries", () => {
    const [entry] = buildPiModelEntries(
      ["glm/glm-5.3"],
      [],
      {},
      () => ({ reasoning: true, contextWindow: 131072 }),
    );
    expect(entry.reasoning).toBe(true);
    expect(entry.contextWindow).toBe(131072);
  });

  it("repairs stale reasoning but preserves hand-set contextWindow", () => {
    const [entry] = buildPiModelEntries(
      ["cheap_models"],
      [{ id: "cheap_models", reasoning: false, contextWindow: 999999, maxTokens: 4096 }],
      {},
      () => ({ reasoning: true, contextWindow: 128000 }),
    );
    expect(entry.reasoning).toBe(true);
    expect(entry.contextWindow).toBe(999999);
    expect(entry.maxTokens).toBe(4096);
  });

  it("fills contextWindow from caps only when the previous entry lacks one", () => {
    const [entry] = buildPiModelEntries(
      ["glm/glm-5.3"],
      [{ id: "glm/glm-5.3", reasoning: false }],
      {},
      () => ({ reasoning: true, contextWindow: 131072 }),
    );
    expect(entry.reasoning).toBe(true);
    expect(entry.contextWindow).toBe(131072);
  });

  it("keeps previous values when the resolver has no data", () => {
    const [entry] = buildPiModelEntries(
      ["weird/model"],
      [{ id: "weird/model", reasoning: true, contextWindow: 999999, maxTokens: 4096 }],
      {},
      () => null,
    );
    expect(entry.reasoning).toBe(true);
    expect(entry.contextWindow).toBe(999999);
    expect(entry.maxTokens).toBe(4096);
  });

  it("defaults to reasoning:false without a resolver (back-compat)", () => {
    const [entry] = buildPiModelEntries(["x/y"], [], {});
    expect(entry.reasoning).toBe(false);
    expect(entry.contextWindow).toBe(200000);
  });
});
