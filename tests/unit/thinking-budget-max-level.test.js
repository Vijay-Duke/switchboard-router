import { describe, expect, it } from "vitest";
import { budgetToLevel } from "../../open-sse/translator/concerns/thinking.js";

// Reverse map must be able to reach "max": LEVEL_TO_BUDGET.max = 128000 and
// xhigh = 32768, so the xhigh/max threshold is their midpoint (80384).
// Previously any budget > 28672 collapsed to "xhigh", making "max"
// unreachable from Claude Code budget_tokens — its default thinking budget
// (MAX_THINKING_TOKENS) could never produce effort "max".
describe("budgetToLevel reaches max tier", () => {
  it("budget 98304 → \"max\"", () => {
    expect(budgetToLevel(98304)).toBe("max");
  });

  it("budget 128000 → \"max\"", () => {
    expect(budgetToLevel(128000)).toBe("max");
  });

  it("budget 80385 → \"max\" (just above midpoint)", () => {
    expect(budgetToLevel(80385)).toBe("max");
  });

  it("budget 80384 → \"xhigh\" (midpoint still xhigh)", () => {
    expect(budgetToLevel(80384)).toBe("xhigh");
  });

  it("budget 31999 stays \"xhigh\"", () => {
    expect(budgetToLevel(31999)).toBe("xhigh");
  });
});

// Switchboard: a large budget now reaches "max", which the Claude adaptive wire
// accepts. (Upstream's codex gpt-5.6 case relies on codex levels not present here.)
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("applyThinking: large budgets reach the max tier", () => {
  it("budget 98304 → output_config.effort max on Claude Opus 4.7", () => {
    const out = applyThinking("claude", "claude-opus-4.7", { thinking: { type: "enabled", budget_tokens: 98304 } }, "claude");
    expect(out.output_config.effort).toBe("max");
  });
});
