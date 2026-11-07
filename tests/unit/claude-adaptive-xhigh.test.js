// claude-adaptive models advertise and send xhigh; Opus/Sonnet 4.6 (which
// reject it) keep low..max and clamp. (ported from upstream 7894f3d3)
import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const effort = (model, level) => {
  const b = { reasoning_effort: level };
  applyThinking("claude", model, b, "claude");
  return b.output_config?.effort;
};

describe("claude-adaptive xhigh", () => {
  it("advertises xhigh for Opus 4.7 / Sonnet 5 but not the 4.6 models", () => {
    expect(getThinkingLevels("claude", "claude-opus-4-7")).toContain("xhigh");
    expect(getThinkingLevels("claude", "claude-sonnet-5")).toContain("xhigh");
    expect(getThinkingLevels("claude", "claude-opus-4-6")).not.toContain("xhigh");
    expect(getThinkingLevels("claude", "claude-sonnet-4.6")).not.toContain("xhigh");
  });

  it("sends xhigh where advertised instead of clamping to high", () => {
    expect(effort("claude-opus-4.7", "xhigh")).toBe("xhigh");
    expect(effort("claude-fable-5-1", "xhigh")).toBe("xhigh");
  });

  it("never sends xhigh to a 4.6 model", () => {
    expect(effort("claude-opus-4-6", "xhigh")).not.toBe("xhigh");
  });
});
