// Claude thinking reaches OpenAI-format clients only as reasoning_content,
// never as literal <think> markers in content. (ported from upstream 5d2cfbf3)
import { describe, it, expect } from "vitest";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

describe("Claude → OpenAI thinking stream", () => {
  it("emits reasoning_content with no <think> markers in content", () => {
    const state = initState(FORMATS.OPENAI);
    const events = [
      { type: "message_start", message: { id: "m1", model: "claude-opus-4-7" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 1 },
    ];
    const out = events.flatMap((e) => translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, e, state) || []);
    const content = out.map((c) => c?.choices?.[0]?.delta?.content).filter(Boolean).join("");
    const reasoning = out.map((c) => c?.choices?.[0]?.delta?.reasoning_content).filter(Boolean).join("");
    expect(content).toBe("answer");
    expect(reasoning).toContain("pondering");
  });
});
