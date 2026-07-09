/**
 * Round-3 regression tests for remaining high-impact routing gateway fixes.
 */
import { describe, it, expect } from "vitest";
import { projectCompletionToClientFormat } from "../../open-sse/translator/response/completionProjector.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { toOpenAIFinish } from "../../open-sse/translator/concerns/finishReason.js";
import { OPENAI_FINISH, GEMINI_ERROR_FINISH_REASONS } from "../../open-sse/translator/schema/finishReasons.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import { isMeaningfulPart } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const baseCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "answer",
      reasoning_content: "think",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) },
      }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

describe("completionProjector (#2347 / PR#2348)", () => {
  it("projects OpenAI completion to Claude with tool_use + thinking", () => {
    const out = projectCompletionToClientFormat(baseCompletion, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.content.some((b) => b.type === "thinking" && b.thinking === "think")).toBe(true);
    expect(out.content.some((b) => b.type === "tool_use" && b.name === "lookup")).toBe(true);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("projects tool_calls into Gemini functionCall parts (not dropped)", () => {
    const out = projectCompletionToClientFormat(baseCompletion, FORMATS.GEMINI);
    const parts = out.response.candidates[0].content.parts;
    expect(parts.some((p) => p.functionCall?.name === "lookup")).toBe(true);
    expect(parts.some((p) => p.thought === true && p.text === "think")).toBe(true);
  });

  it("passthrough for OpenAI source format", () => {
    expect(projectCompletionToClientFormat(baseCompletion, FORMATS.OPENAI)).toBe(baseCompletion);
  });
});

describe("Gemini MALFORMED_FUNCTION_CALL → error (#2462)", () => {
  it("maps to OPENAI_FINISH.ERROR not stop", () => {
    expect(toOpenAIFinish("MALFORMED_FUNCTION_CALL", "gemini")).toBe(OPENAI_FINISH.ERROR);
    expect(GEMINI_ERROR_FINISH_REASONS.has("MALFORMED_FUNCTION_CALL")).toBe(true);
  });
});

describe("openai→claude doubled tool args + finish guard (#2279)", () => {
  it("deduplicates doubled JSON args and only finishes once", () => {
    const state = { toolCalls: new Map(), nextBlockIndex: 0, toolArgBuffers: new Map() };
    const doubled = '{"q":1}{"q":1}';
    // start tool call
    openaiToClaudeResponse({
      id: "c1",
      model: "m",
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "" } }],
        },
      }],
    }, state);
    // args buffer
    openaiToClaudeResponse({
      id: "c1",
      model: "m",
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: doubled } }],
        },
      }],
    }, state);
    // finish twice
    const r1 = openaiToClaudeResponse({
      id: "c1", model: "m",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state);
    const r2 = openaiToClaudeResponse({
      id: "c1", model: "m",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state);

    const deltas = (r1 || []).filter((e) => e.delta?.type === "input_json_delta");
    expect(deltas).toHaveLength(1);
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ q: 1 });
    // second finish is a no-op (null or empty)
    expect(!r2 || r2.length === 0).toBe(true);
  });
});

describe("Claude tools default type custom (#2195)", () => {
  it("adds type:custom for bare tools on non-claude providers", () => {
    const body = {
      model: "MiniMax-M3",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather", description: "wx", input_schema: { type: "object", properties: {} } }],
    };
    prepareClaudeRequest(body, "minimax");
    expect(body.tools[0].type).toBe("custom");
    expect(body.tools[0].name).toBe("get_weather");
  });
});

describe("Gemini schema strips multipleOf and ref (#2309 / #1036)", () => {
  it("removes multipleOf and ref keywords", () => {
    const schema = {
      type: "object",
      properties: {
        n: { type: "number", multipleOf: 0.5, minimum: 0, maximum: 10 },
        x: { ref: "#/definitions/X", type: "string" },
      },
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.n.multipleOf).toBeUndefined();
    expect(cleaned.properties.n.minimum).toBeUndefined();
    expect(cleaned.properties.x.ref).toBeUndefined();
  });
});

describe("emptyStreamGuard isMeaningfulPart (#2462)", () => {
  it("treats thought-only as empty, tool/text as meaningful", () => {
    expect(isMeaningfulPart({ thought: true, text: "planning" })).toBe(false);
    expect(isMeaningfulPart({ text: "   " })).toBe(false);
    expect(isMeaningfulPart({ text: "hello" })).toBe(true);
    expect(isMeaningfulPart({ functionCall: { name: "x" } })).toBe(true);
  });
});
