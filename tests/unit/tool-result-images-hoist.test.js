// Tool-result images must survive non-Anthropic Claude-compatible endpoints and
// Kiro, which drop images inside a tool result. (ported from upstream f4f06f29)
import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const shot = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const body = () => ({
  model: "kimi-k2.6",
  max_tokens: 64,
  messages: [
    { role: "user", content: "take a screenshot" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [shot] }] },
  ],
});

describe("tool-result image hoisting", () => {
  it("moves the image after the tool results for non-Anthropic Claude-compatible providers", () => {
    const turn = prepareClaudeRequest(body(), "kimi").messages[2].content;
    expect(turn[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "(image attached below)" }] });
    expect(turn[1]).toEqual({ type: "text", text: "[Image from tool result t1]" });
    expect(turn[2]).toEqual(shot);
  });

  it("leaves Anthropic's own tool results untouched", () => {
    const turn = prepareClaudeRequest(body(), "claude").messages[2].content;
    expect(turn).toHaveLength(1);
    expect(turn[0].content[0]).toMatchObject({ type: "image" });
  });

  it("Kiro forwards a tool's screenshot as a user image", () => {
    const payload = claudeToKiroRequest("claude-sonnet-4.5", {
      ...body(),
      tools: [{ name: "screenshot", description: "take a screenshot", input_schema: { type: "object", properties: {} } }],
    }, true, {});
    const json = JSON.stringify(payload);
    expect(json).toContain('"bytes":"AAAA"');
    expect(json).toContain("(image attached)");
    expect(json).not.toContain('\\"data\\":\\"AAAA\\"');
  });
});
