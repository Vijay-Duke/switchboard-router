// Some clients send message content as a single block object; it must survive
// every leg instead of being dropped. (ported from upstream 8a81085a)
import { describe, it, expect } from "vitest";
import { prepareClaudeRequest, normalizeClaudePassthrough, anchorClaudeCache } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const body = () => ({
  model: "claude-opus-4.7",
  max_tokens: 100,
  messages: [
    { role: "user", content: { type: "text", text: "hello", cache_control: { type: "ephemeral" } } },
    { role: "assistant", content: { type: "text", text: "hi" } },
    { role: "user", content: "next" },
  ],
});

describe("single-object Claude message content", () => {
  it("prepareClaudeRequest keeps the turns as one-block arrays", () => {
    const out = prepareClaudeRequest(body(), "claude");
    expect(out.messages.map(m => m.content[0].text)).toEqual(["hello", "hi", "next"]);
  });

  it("passthrough normalize + anchor wraps the object and drops its client marker", () => {
    const out = anchorClaudeCache(normalizeClaudePassthrough(body()));
    expect(out.messages[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(Array.isArray(out.messages[1].content)).toBe(true);
  });

  it("claude→openai keeps the history", () => {
    const out = translateRequest("claude", "openai", "gpt-5", body(), false, null, "openai");
    expect(out.messages.map(m => m.content)).toEqual(["hello", "hi", "next"]);
  });
});
