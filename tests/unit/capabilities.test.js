import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
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

  it("reports Claude Fable 5.1 as a permanent adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("claude", "claude-fable-5-1")).toMatchObject({
      ...claudeSonnet5Expected,
      thinkingCanDisable: false,
    });
  });

  // Switchboard: the commandcode wire shape comes from the target format
  // (thinkingUnified.resolveFormat), so caps carry no thinkingFormat here.
  it("CommandCode v4.1-flash is vision + effort capable", () => {
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4.1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingEffortSupported: true,
    });
  });

  it("CommandCode MiniMax-M3 is vision capable", () => {
    expect(getCapabilitiesForModel("commandcode", "MiniMaxAI/MiniMax-M3").vision).toBe(true);
  });

  it("CommandCode text-only DeepSeek V4 Flash stays non-vision", () => {
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-flash").vision).toBe(false);
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-flash")).toMatchObject({
      reasoning: true,
      thinkingEffortSupported: true,
    });
  });
});
