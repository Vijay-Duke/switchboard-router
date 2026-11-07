// DeepSeek models behind OpenCode Go /messages need the official DeepSeek
// thinking pass-back handling. (ported from upstream 08b21fea)
import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const body = (model, assistantContent) => ({
  model,
  max_tokens: 100,
  thinking: { type: "enabled", budget_tokens: 1024 },
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: assistantContent },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ],
});
const toolUse = { type: "tool_use", id: "t1", name: "read", input: {} };

describe("opencode-go DeepSeek /messages thinking", () => {
  it("injects an unsigned placeholder on a tool_use turn missing thinking", () => {
    const out = prepareClaudeRequest(body("deepseek-v4-pro", [toolUse]), "opencode-go");
    expect(out.messages[1].content[0]).toEqual({ type: "thinking", thinking: "." });
  });

  it("keeps existing unsigned thinking verbatim", () => {
    const thinking = { type: "thinking", thinking: "real reasoning" };
    const out = prepareClaudeRequest(body("deepseek-v4-pro(max)", [thinking, toolUse]), "opencode-go");
    expect(out.messages[1].content[0]).toEqual(thinking);
  });

  it("leaves non-DeepSeek opencode-go models alone", () => {
    const out = prepareClaudeRequest(body("minimax-m3", [toolUse]), "opencode-go");
    expect(out.messages[1].content.some((b) => b.type === "thinking" && b.thinking === "." && !b.signature)).toBe(false);
  });
});
