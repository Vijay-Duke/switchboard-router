import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  it("reports DeepSeek V4.1-Flash ids as vision-capable without dropping their thinking/context", () => {
    const v41 = { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000 };
    expect(getCapabilitiesForModel(undefined, "deepseek-v4.1-flash")).toMatchObject(v41);
    expect(getCapabilitiesForModel("opencode-go", "deepseek-v4.1-flash")).toMatchObject(v41);
    expect(getCapabilitiesForModel("openrouter", "deepseek/deepseek-v4.1-flash")).toMatchObject(v41);
    // Hyphenated gateway alias (e.g. Kenari) used to match *deepseek-v4* as text-only.
    expect(getCapabilitiesForModel("kenari", "deepseek-v4-1-flash")).toMatchObject(v41);
    // "deepseek-flash" is the GA id for V4.1-Flash; keep the 128K/64K limits it had.
    expect(getCapabilitiesForModel("opencode-go", "deepseek-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 128000,
      maxOutput: 64000,
    });
    // the superseded text-only Flash id stays text-only
    expect(getCapabilitiesForModel("opencode-go", "deepseek-v4-flash").vision).toBe(false);
  });

  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });
});

describe("OpenCode Free ids newer than the capability tables", () => {
  // ids missing here fall through to DEFAULT_CAPABILITIES (reasoning: false),
  // and applyThinking() then deletes the client's reasoning_effort — see #2690.
  // Modalities/limits are taken verbatim from models.dev.
  it("reports reasoning and the models.dev limits for space-bunny", () => {
    expect(getCapabilitiesForModel(undefined, "space-bunny-free")).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 1048576,
      maxOutput: 524288,
    });
    expect(getCapabilitiesForModel("opencode-go", "space-bunny")).toMatchObject({
      reasoning: true,
      contextWindow: 1048576,
      maxOutput: 524288,
    });
  });

  it("keeps per-id modalities and limits instead of a generic floor", () => {
    // text-only, small context — a shared pattern rule would overstate both.
    expect(getCapabilitiesForModel(undefined, "big-pickle")).toMatchObject({
      reasoning: true,
      vision: false,
      contextWindow: 200000,
      maxOutput: 32000,
    });
    expect(getCapabilitiesForModel(undefined, "ring-2.6-1t-free")).toMatchObject({
      reasoning: true,
      vision: false,
      contextWindow: 262000,
      maxOutput: 66000,
    });
    expect(getCapabilitiesForModel(undefined, "exo-free")).toMatchObject({
      reasoning: true,
      vision: true,
      contextWindow: 1048576,
      maxOutput: 131072,
    });
  });
});
