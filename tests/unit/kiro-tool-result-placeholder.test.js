// A Kiro user turn that only carries tool results gets a neutral placeholder,
// not "continue" (models answered the word and dropped the task).
// (ported from upstream 82b1bca4)
import { describe, it, expect } from "vitest";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const tools = [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }];

describe("Kiro tool-result-only user turn", () => {
  it("uses 'Tool results provided.' instead of 'continue'", () => {
    const payload = claudeToKiroRequest("claude-sonnet-4.5", {
      tools,
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }] },
      ],
    }, true, {});
    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content).toContain("Tool results provided.");
    expect(content).not.toMatch(/\bcontinue\b/);
  });
});
