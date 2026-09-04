import { describe, expect, it } from "vitest";

import { parseChatCompletionsSSEToJson } from "../../open-sse/transformer/streamToJsonConverter.js";

function sse(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

describe("Chat Completions SSE → JSON per-choice accumulation (H3/H4/H5)", () => {
  it("keeps n>1 choices separate, one per index in order", () => {
    const json = parseChatCompletionsSSEToJson(sse([
      { id: "chatcmpl-1", model: "m", choices: [{ index: 1, delta: { role: "assistant", content: "two" } }] },
      { choices: [{ index: 0, delta: { role: "assistant", content: "one" } }] },
      { choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "length" }] },
    ]), "fallback");

    expect(json.choices.map((c) => c.index)).toEqual([0, 1]);
    expect(json.choices[0].message.content).toBe("one!");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.choices[1].message.content).toBe("two");
    expect(json.choices[1].finish_reason).toBe("length");
  });

  it("defaults empty tool-call arguments to {} so clients can JSON.parse them", () => {
    const json = parseChatCompletionsSSEToJson(sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ping", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]), "m");

    const call = json.choices[0].message.tool_calls[0];
    expect(call.function.arguments).toBe("{}");
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
    expect(json.choices[0].message.content).toBeNull();
  });

  it("ignores a re-sent full tool name but still concatenates split fragments", () => {
    const repeated = parseChatCompletionsSSEToJson(sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "{\"c\":" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "get_weather", arguments: "\"x\"}" } }] } }] },
    ]), "m");
    expect(repeated.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(repeated.choices[0].message.tool_calls[0].function.arguments).toBe("{\"c\":\"x\"}");

    const split = parseChatCompletionsSSEToJson(sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "weather" } }] } }] },
    ]), "m");
    expect(split.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
  });
});
