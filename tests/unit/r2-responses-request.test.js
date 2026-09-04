/** Round-2 request-translator findings X37–X41, X68 (openai-responses). */
import { describe, it, expect } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";

const reasoningItem = (text) => ({
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
});
const msgItem = (role, text) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const fnCall = (call_id, name = "f") => ({
  type: "function_call", call_id, name, arguments: "{}",
});

describe("X37 buffered reasoning", () => {
  it("reasoning-before-message attaches to the assistant turn", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [reasoningItem("thought-a"), msgItem("assistant", "answer")],
    }, true);
    const asst = out.messages.find((m) => m.role === "assistant");
    expect(asst.reasoning_content).toBe("thought-a");
  });
  it("reasoning between calls attaches to the open assistant message", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [fnCall("c1"), reasoningItem("mid-thought"), fnCall("c2")],
    }, true);
    const asst = out.messages.find((m) => m.role === "assistant");
    expect(asst.tool_calls).toHaveLength(2);
    expect(asst.reasoning_content).toBe("mid-thought");
  });
  it("trailing reasoning is not dropped", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [msgItem("user", "hi"), reasoningItem("trailing")],
    }, true);
    expect(JSON.stringify(out.messages)).toContain("trailing");
  });
});

describe("X38 chat→responses passthrough", () => {
  const base = () => ({ messages: [{ role: "user", content: "hi" }] });
  it("tool_choice string passes through", () => {
    expect(openaiToOpenAIResponsesRequest("m", { ...base(), tool_choice: "required" }, true).tool_choice)
      .toBe("required");
  });
  it("forced function converts to Responses shape", () => {
    expect(openaiToOpenAIResponsesRequest("m", {
      ...base(), tool_choice: { type: "function", function: { name: "f" } },
    }, true).tool_choice).toEqual({ type: "function", name: "f" });
  });
  it("stop is dropped (not a Responses API parameter — would 400)", () => {
    expect(openaiToOpenAIResponsesRequest("m", { ...base(), stop: ["END"] }, true).stop)
      .toBeUndefined();
  });
  it("response_format becomes text.format", () => {
    const j = openaiToOpenAIResponsesRequest("m", {
      ...base(), response_format: { type: "json_object" },
    }, true);
    expect(j.text).toEqual({ format: { type: "json_object" } });
    const s = openaiToOpenAIResponsesRequest("m", {
      ...base(),
      response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } },
    }, true);
    expect(s.text.format.type).toBe("json_schema");
    expect(s.text.format.schema).toEqual({ type: "object" });
  });
});

describe("X39 multi-system instructions", () => {
  it("two systems + developer concatenate", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [
        { role: "system", content: "sys1" },
        { role: "system", content: [{ type: "text", text: "sys2" }] },
        { role: "developer", content: "dev" },
        { role: "user", content: "hi" },
      ],
    }, true);
    expect(out.instructions).toBe("sys1\nsys2\ndev");
  });
});

describe("X40 claude-shaped tool schemas", () => {
  const run = (tool) => openaiResponsesToOpenAIRequest("m", {
    input: [msgItem("user", "hi")],
    tools: [tool],
  }, true).tools[0].function.parameters;
  it("input_schema keeps properties + required", () => {
    const params = run({
      type: "function", name: "q", description: "d",
      input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
    expect(params.properties.q).toBeDefined();
    expect(params.required).toEqual(["q"]);
  });
  it("parameters shape still works", () => {
    const params = run({
      type: "function", name: "q", parameters: { type: "object", properties: { a: { type: "number" } } },
    });
    expect(params.properties.a).toBeDefined();
  });
});

describe("X41 tool-result join", () => {
  it("two-part tool content stays delimited", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "p1" }, { type: "text", text: "p2" }] },
      ],
    }, true);
    const item = out.input.find((i) => i.type === "function_call_output");
    expect(item.output).toBe("p1\np2");
  });
});

describe("X68 parallel_tool_calls passes through natively; history untouched", () => {
  it("both function_call items survive and the flag is forwarded", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }],
      parallel_tool_calls: false,
    }, true);
    const calls = out.input.filter((i) => i.type === "function_call");
    expect(calls).toHaveLength(2);
    expect(out.parallel_tool_calls).toBe(false);
  });
});
