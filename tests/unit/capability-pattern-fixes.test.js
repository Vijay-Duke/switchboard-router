import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel — MiMo (<think>-tag reasoning, always-on)", () => {
  it("mimo-v2.5 has vision + reasoning + deepseek format, cannot disable", () => {
    const caps = getCapabilitiesForModel(null, "mimo-v2.5");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("deepseek");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("mimo-v2.5-pro has vision (matches *mimo*v2.5* pattern)", () => {
    const caps = getCapabilitiesForModel(null, "mimo-v2.5-pro");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("deepseek");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("xiaomi/mimo-v2.5-pro (vendor-prefixed) has vision", () => {
    const caps = getCapabilitiesForModel(null, "xiaomi/mimo-v2.5-pro");
    expect(caps.vision).toBe(true);
    expect(caps.thinkingFormat).toBe("deepseek");
  });

  it("mimo-omni-x has audioInput via the omni pattern", () => {
    const caps = getCapabilitiesForModel(null, "mimo-omni-x");
    expect(caps.vision).toBe(true);
    expect(caps.audioInput).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("generic mimo has vision + reasoning (fallback pattern)", () => {
    const caps = getCapabilitiesForModel(null, "mimo");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });
});

describe("getCapabilitiesForModel — Qwen max/plus vision", () => {
  it("qwen3.7-max has vision (*qwen*max* fires before *qwen3.7*)", () => {
    const caps = getCapabilitiesForModel(null, "qwen3.7-max");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
  });

  it("Qwen3.6-Max-Preview has vision (case-insensitive pattern match)", () => {
    const caps = getCapabilitiesForModel(null, "Qwen3.6-Max-Preview");
    expect(caps.vision).toBe(true);
  });

  it("qwen3.7-plus has vision", () => {
    const caps = getCapabilitiesForModel(null, "qwen3.7-plus");
    expect(caps.vision).toBe(true);
  });

  it("qwen3.7 has vision from the qwen3.7 pattern", () => {
    const caps = getCapabilitiesForModel(null, "qwen3.7");
    expect(caps.vision).toBe(true);
  });

  it("qwq has no vision (thinking-only model)", () => {
    const caps = getCapabilitiesForModel(null, "qwq-32b");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });
});

describe("getCapabilitiesForModel — MiniMax M2.x vision", () => {
  it("minimax-m2.7 has vision", () => {
    const caps = getCapabilitiesForModel(null, "minimax-m2.7");
    expect(caps.vision).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("minimax-m2.5 has vision", () => {
    const caps = getCapabilitiesForModel(null, "minimax-m2.5");
    expect(caps.vision).toBe(true);
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("MiniMax-M2.7 has vision (vendor prefix MiniMaxAI/ stripped by route)", () => {
    const caps = getCapabilitiesForModel(null, "MiniMaxAI/MiniMax-M2.7");
    expect(caps.vision).toBe(true);
  });

  it("minimax-m3 has vision (separate pattern)", () => {
    const caps = getCapabilitiesForModel(null, "minimax-m3");
    expect(caps.vision).toBe(true);
  });
});
