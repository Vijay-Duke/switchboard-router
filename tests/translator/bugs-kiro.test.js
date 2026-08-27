// OpenAI → Kiro (AWS CodeWhisperer) request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const O2K = (body) => translateRequest(FORMATS.OPENAI, FORMATS.KIRO, "m", body, true, null, "kiro");

describe("OpenAI → Kiro", () => {
  // openai-to-kiro.js — safeJSONParse guards bad tool-call JSON (fixed in PR #1582)
  it("malformed tool arguments do not throw the whole request", () => {
    expect(() =>
      O2K({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "f", arguments: "{not json" } },
          ] },
          { role: "tool", tool_call_id: "c1", content: "r" },
        ],
      })
    ).not.toThrow();
  });

  // openai-to-kiro.js: respects client max_tokens
  it("respects client max_tokens", () => {
    const out = O2K({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens, "client max_tokens ignored").toBe(100);
  });

  // openai-to-kiro.js: remote http image becomes text placeholder (Kiro backend only supports base64)
  it("remote image url is safely converted to text placeholder for Kiro", () => {
    const out = O2K({
      messages: [{ role: "user", content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "https://x.com/p.png" } },
      ] }],
    });
    const content = out.conversationState?.currentMessage?.userInputMessage?.content || "";
    expect(content).toContain("[Image: https://x.com/p.png]");
  });
});
