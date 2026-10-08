import { describe, expect, it } from "vitest";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { ROLE, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

const redacted = { type: CLAUDE_BLOCK.REDACTED_THINKING, data: "opaque-encrypted-reasoning" };
const toolUse = { type: CLAUDE_BLOCK.TOOL_USE, id: "call_a", name: "Bash", input: {} };
const fixture = (thinking = { type: "adaptive" }) => ({
  model: "claude-opus-5-5",
  max_tokens: 16384,
  thinking,
  messages: [
    { role: ROLE.USER, content: "Run the tool" },
    { role: ROLE.ASSISTANT, content: [structuredClone(redacted), structuredClone(toolUse)] },
    { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: "call_a", content: "actual output" }] },
  ],
});

describe("Claude redacted thinking in tool history", () => {
  it.each([{ type: "adaptive" }, { type: "enabled", budget_tokens: 4096 }])(
    "preserves the opaque data block during native normalization with %j",
    (thinking) => {
      const original = fixture(thinking);
      const snapshot = structuredClone(original);
      const normalized = normalizeClaudePassthrough({ ...original }, original.model);
      expect(normalized.messages[1].content).toEqual([redacted, toolUse]);
      expect(original).toEqual(snapshot);
    },
  );

  it("preserves the original redacted block when preparing a Claude tool continuation", () => {
    const prepared = prepareClaudeRequest(fixture({ type: "enabled", budget_tokens: 4096 }), "claude");
    expect(prepared.messages[1].content[0]).toEqual(redacted);
    expect(prepared.messages[1].content.filter(block => block.type === CLAUDE_BLOCK.THINKING)).toEqual([]);
  });

  it("does not add a regular-thinking signature to redacted data for compatible providers", () => {
    const prepared = prepareClaudeRequest(fixture(), "anthropic-compatible-test");
    expect(prepared.messages[1].content[0]).toEqual(redacted);
  });

  it("continues to discard a foreign regular-thinking signature", () => {
    const body = fixture();
    body.messages[1].content.unshift({ type: CLAUDE_BLOCK.THINKING, thinking: "foreign", signature: "not-a-claude-signature" });
    normalizeClaudePassthrough(body, body.model);
    expect(body.messages[1].content).toEqual([redacted, toolUse]);
  });
});
