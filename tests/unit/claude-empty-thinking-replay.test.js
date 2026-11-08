import { expect, it } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

it("drops empty thinking while preserving opaque redacted history", () => {
  const redacted = { type: "redacted_thinking", data: "opaque-encrypted-data" };
  const body = {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "   ", signature: "invalid" },
        redacted,
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
    ],
  };
  prepareClaudeRequest(body, "claude");
  const blocks = body.messages.find(message => message.role === "assistant").content;
  expect(blocks).toContainEqual(redacted);
  expect(blocks.some(block => block.type === "thinking")).toBe(false);
});
