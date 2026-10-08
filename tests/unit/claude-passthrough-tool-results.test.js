import { describe, expect, it } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { ROLE, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

const toolUse = (id) => ({ type: CLAUDE_BLOCK.TOOL_USE, id, name: "Bash", input: {} });
const result = (id) => ({ type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: id, content: `actual ${id}`, is_error: false });
const text = (value) => ({ type: CLAUDE_BLOCK.TEXT, text: value });
const fixture = () => ({ messages: [
  { role: ROLE.USER, content: [text("Run the tool")] },
  { role: ROLE.ASSISTANT, content: [toolUse("call_a")] },
  { role: ROLE.SYSTEM, content: "Token reminder" },
  { role: ROLE.USER, content: [result("call_a")] },
] });

describe("Claude passthrough tool-result ordering", () => {
  it("keeps a real result before a system reminder inserted after its call", () => {
    const body = fixture();
    normalizeClaudePassthrough(body);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({ role: ROLE.USER, content: [result("call_a"), text("Token reminder")] });
  });

  it("collects all parallel results before a reminder between result turns", () => {
    const body = { messages: [
      { role: ROLE.ASSISTANT, content: [toolUse("a"), toolUse("b")] },
      { role: ROLE.USER, content: [result("a")] },
      { role: ROLE.SYSTEM, content: "Reminder" },
      { role: ROLE.USER, content: [result("b"), text("Continue")] },
    ] };
    normalizeClaudePassthrough(body);
    expect(body.messages[1].content).toEqual([result("a"), result("b"), text("Reminder"), text("Continue")]);
  });

  it("preserves error results and image content while ordering the result first", () => {
    const image = { type: CLAUDE_BLOCK.IMAGE, source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } };
    const failed = { ...result("a"), content: "Tool execution failed", is_error: true };
    const body = { messages: [
      { role: ROLE.ASSISTANT, content: [toolUse("a")] },
      { role: ROLE.USER, content: [text("Reminder"), failed, image] },
    ] };
    normalizeClaudePassthrough(body);
    expect(body.messages[1].content).toEqual([failed, text("Reminder"), image]);
  });

  it("does not invent a result for a tool that never returned", () => {
    const body = fixture();
    body.messages[3].content = [text("No result is available")];
    normalizeClaudePassthrough(body);
    expect(body.messages.flatMap(message => message.content || []).filter(block => block.type === CLAUDE_BLOCK.TOOL_RESULT)).toEqual([]);
  });

  it("does not change history shared with another account attempt", () => {
    const original = fixture();
    const snapshot = structuredClone(original);
    normalizeClaudePassthrough({ ...original });
    expect(original).toEqual(snapshot);
  });

  it("is stable when normalized again for an account retry", () => {
    const body = fixture();
    normalizeClaudePassthrough(body);
    const snapshot = structuredClone(body);
    normalizeClaudePassthrough(body);
    expect(body).toEqual(snapshot);
  });

  it("preserves separate ordinary user turns when no tool call precedes them", () => {
    const body = { messages: [
      { role: ROLE.SYSTEM, content: "Preamble" },
      { role: ROLE.USER, content: "Question" },
    ] };
    normalizeClaudePassthrough(body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toEqual([text("Preamble")]);
    expect(body.messages[1].content).toBe("Question");
  });
});
