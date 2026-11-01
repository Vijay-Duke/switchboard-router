// OpenAI → Gemini / Cursor / CommandCode request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const O2G = (body) => translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "m", body, true, null, "gemini");
const O2C = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CURSOR, "m", body, true, null, "cursor");
const O2CC = (body) => translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE, "m", body, true, null, "commandcode");

describe("OpenAI → Gemini", () => {
  it("multiple system messages are all kept", () => {
    const out = O2G({
      messages: [
        { role: "system", content: "RULE_ONE" },
        { role: "system", content: "RULE_TWO" },
        { role: "user", content: "hi" },
      ],
    });
    expect(JSON.stringify(out.systemInstruction), "earlier system lost").toContain("RULE_ONE");
    expect(JSON.stringify(out.systemInstruction), "later system lost").toContain("RULE_TWO");
  });
});

describe("OpenAI → Cursor", () => {
  // openai-to-cursor.js: image content preserved
  it("image content is preserved", () => {
    const out = O2C({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
    });
    expect(JSON.stringify(out), "image dropped").toContain("AAAA");
  });

  // openai-to-cursor.js: respects client max_tokens
  it("respects client max_tokens", () => {
    const out = O2C({ max_tokens: 200, messages: [{ role: "user", content: "hi" }] });
    expect(out.max_tokens).toBe(200);
  });
});

describe("OpenAI → CommandCode", () => {
  it.each(["high", "max"])("keeps DeepSeek effort %s inside params", (effort) => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4.1-flash", {
        messages: [{ role: "user", content: "hi" }], reasoning_effort: effort,
      }, true, null, "commandcode");
    expect(out.params.reasoning_effort).toBe(effort);
    expect(out.params.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  it("keeps a suffix effort inside params on tool-result turns", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4.1-flash(max)", {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "done" },
        ],
      }, true, null, "commandcode");
    expect(out.params.reasoning_effort).toBe("max");
    expect(out.reasoning_effort).toBeUndefined();
  });

  it.each([
    ["none", "none"], ["auto", "high"], ["xhigh", "max"],
  ])("normalizes %s to %s in the Command Code envelope", (requested, expected) => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE,
      "deepseek/deepseek-v4.1-flash", {
        messages: [{ role: "user", content: "hi" }], reasoning_effort: requested,
      }, true, null, "commandcode");
    expect(out.params.reasoning_effort).toBe(expected);
    expect(out.params.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
  });

  // openai-to-commandcode.js: safeParseJson preserves malformed args in raw property
  it("malformed tool arguments are not silently emptied", () => {
    const out = O2CC({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{bad" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    });
    const asst = out.params.messages.find((m) => m.role === "assistant");
    const call = asst.content.find((b) => b.type === "tool-call");
    expect(Object.keys(call.input).length, "arguments silently dropped to {}").toBeGreaterThan(0);
  });

  // openai-to-commandcode.js: image content preserved
  it("image content is preserved", () => {
    const out = O2CC({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ] }],
    });
    expect(JSON.stringify(out), "image omitted").toContain("BBBB");
  });
});
