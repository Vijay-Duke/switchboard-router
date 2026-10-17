// Auto-select thinking effort per model (CLIProxyAPI clampLevel equivalent):
// requested levels clamp to the model's supported list; "auto" gets a concrete
// level on formats with no native dynamic effort.
import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("applyThinking auto effort selection", () => {
  it("clamps unsupported level to nearest supported (gpt-5 has no max → xhigh)", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { reasoning_effort: "max" }, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });

  it("clamps below the supported list up (codex minimal → low)", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5-codex", { reasoning_effort: "minimal" }, "codex");
    expect(out.reasoning_effort).toBe("low");
  });

  it("supported level passes through untouched", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { reasoning_effort: "high" }, "openai");
    expect(out.reasoning_effort).toBe("high");
  });

  it("auto becomes a concrete supported level on openai wire (never leaks \"auto\")", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { reasoning: { effort: "auto" } }, "openai");
    expect(out.reasoning_effort).toBe("medium");
  });

  it("auto clamps to nearest supported on deepseek (medium → high)", () => {
    const out = applyThinking(FORMATS.OPENAI, "deepseek-v4", { reasoning_effort: "auto" }, "deepseek");
    expect(out.reasoning_effort).toBe("high");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("auto stays dynamic on adaptive-capable wires (claude)", () => {
    const out = applyThinking(FORMATS.OPENAI, "claude-sonnet-4-5", { reasoning_effort: "auto" }, "anthropic");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.thinking.budget_tokens).toBeUndefined();
  });

  it("tie clamps to the higher level (xhigh on deepseek [high,max] → max)", () => {
    const out = applyThinking(FORMATS.OPENAI, "deepseek-v4", { reasoning_effort: "xhigh" }, "deepseek");
    expect(out.reasoning_effort).toBe("max");
  });
});
