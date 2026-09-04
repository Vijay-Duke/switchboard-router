import { describe, it, expect } from "vitest";

import { detectFormat } from "../../open-sse/services/provider.js";

describe("detectFormat scans all messages (E11)", () => {
  it("detects Claude tool_use in a later turn", () => {
    expect(detectFormat({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "1", name: "x", input: {} }],
        },
      ],
    })).toBe("claude");
  });

  it("detects a Claude base64 image past messages[0]", () => {
    expect(detectFormat({
      messages: [
        { role: "user", content: "first" },
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } }],
        },
      ],
    })).toBe("claude");
  });

  it("still detects OpenAI image_url in a later turn", () => {
    expect(detectFormat({
      messages: [
        { role: "user", content: "first" },
        {
          role: "user",
          content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "https://x/y.png" } }],
        },
      ],
    })).toBe("openai");
  });

  it("keeps single-turn behavior: plain OpenAI stays openai", () => {
    expect(detectFormat({ messages: [{ role: "user", content: "hi" }], model: "gpt-5" })).toBe("openai");
  });

  it("keeps single-turn behavior: Claude text + system stays claude", () => {
    expect(detectFormat({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })).toBe("claude");
  });

  it("ignores tool markers when the model id is provider-qualified", () => {
    expect(detectFormat({
      model: "p/m",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "x", input: {} }] }],
    })).toBe("openai");
  });
});
