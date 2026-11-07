// Gemini rejects a functionCall id repeated anywhere in the history; OpenAI
// ids are only unique per assistant turn. (ported from upstream 6e4f82db)
import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const turn = (id, name, result) => [
  { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content: result },
];

describe("openai→gemini duplicate tool_call_id", () => {
  it("emits unique paired ids and answers each turn with its own result and name", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [
        { role: "user", content: "go" },
        ...turn("call_1", "read", "first"),
        { role: "user", content: "again" },
        ...turn("call_1", "write", "second"),
        { role: "user", content: "and again" },
        ...turn("call_1", "read", "third"),
      ],
    }, false);
    const calls = out.contents.flatMap(c => c.parts).filter(p => p.functionCall).map(p => p.functionCall);
    const responses = out.contents.flatMap(c => c.parts).filter(p => p.functionResponse).map(p => p.functionResponse);
    expect(calls.map(c => c.id)).toEqual(["call_1", "call_1-2", "call_1-3"]);
    expect(responses.map(r => r.id)).toEqual(["call_1", "call_1-2", "call_1-3"]);
    expect(responses.map(r => r.response.result)).toEqual(["first", "second", "third"]);
    expect(responses.map(r => r.name)).toEqual(["read", "write", "read"]);
  });

  it("leaves already-unique ids untouched", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [{ role: "user", content: "go" }, ...turn("a", "read", "x"), { role: "user", content: "next" }, ...turn("b", "read", "y")],
    }, false);
    const ids = out.contents.flatMap(c => c.parts).filter(p => p.functionCall).map(p => p.functionCall.id);
    expect(ids).toEqual(["a", "b"]);
  });
});
