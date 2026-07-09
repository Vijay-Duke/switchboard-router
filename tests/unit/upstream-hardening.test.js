/**
 * Regression tests for high-impact fixes ported from decolua/9router issues/PRs.
 */
import { describe, it, expect } from "vitest";
import { extractThinkTags, createThinkExtractor } from "../../open-sse/utils/thinkExtractor.js";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { coerceSchemaNumericConstraints } from "../../open-sse/translator/formats/openai.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

// Register translators used by tool unwrap test
import "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

describe("thinkExtractor (#2463 MiniMax M3 <think> tags)", () => {
  it("extracts complete think block from finished content", () => {
    const { content, reasoning } = extractThinkTags("<think>plan first</think>\nHello");
    expect(reasoning).toBe("plan first");
    expect(content).toBe("Hello");
  });

  it("streams across chunk boundaries", () => {
    const ex = createThinkExtractor();
    const a = ex("<think>step ");
    expect(a.content).toBe("");
    expect(a.reasoning).toBeNull();
    const b = ex("one</think>answer");
    expect(b.reasoning).toBe("step one");
    expect(b.content).toBe("answer");
  });
});

describe("systemInject dedup (#2443)", () => {
  const PROMPT = "Respond like terse caveman. All technical substance stay exact, only fluff die.";

  it("does not duplicate system prompt on second inject (OpenAI)", () => {
    const body = { messages: [{ role: "system", content: "Base rules." }] };
    injectSystemPrompt(body, FORMATS.OPENAI, PROMPT);
    const afterFirst = body.messages[0].content;
    injectSystemPrompt(body, FORMATS.OPENAI, PROMPT);
    expect(body.messages[0].content).toBe(afterFirst);
    expect((body.messages[0].content.match(/terse caveman/g) || []).length).toBe(1);
  });

  it("does not duplicate Claude system string", () => {
    const body = { system: "Existing." };
    injectSystemPrompt(body, FORMATS.CLAUDE, PROMPT);
    injectSystemPrompt(body, FORMATS.CLAUDE, PROMPT);
    expect((body.system.match(/terse caveman/g) || []).length).toBe(1);
  });
});

describe("coerceSchemaNumericConstraints (#422)", () => {
  it("converts string numeric schema keywords to numbers", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", maxLength: "64", minLength: "1" },
      },
      maxProperties: "10",
    };
    const out = coerceSchemaNumericConstraints(schema);
    expect(out.properties.name.maxLength).toBe(64);
    expect(out.properties.name.minLength).toBe(1);
    expect(out.maxProperties).toBe(10);
  });
});

describe("parseSSEToOpenAIResponse tool_calls (#345)", () => {
  it("reassembles tool_calls from streaming deltas", () => {
    const sse = [
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":""}}]}}]}',
      'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}',
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n");
    const parsed = parseSSEToOpenAIResponse(sse, "test-model");
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1);
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe("echo");
    expect(parsed.choices[0].message.tool_calls[0].function.arguments).toBe('{"x":1}');
    expect(parsed.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("openai reasoning_effort max→xhigh (#2466)", () => {
  it("clamps reasoning_effort max to xhigh", () => {
    const body = { reasoning_effort: "max" };
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", body, "openai");
    expect(out.reasoning_effort).toBe("xhigh");
  });
});

describe("openai→claude bare function tools (#2473 / #2435)", () => {
  it("unwraps tools without parent type:function", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { function: { name: "echo", description: "Echo", parameters: { type: "object", properties: {} } } },
      ],
    }, true);
    expect(out.tools).toBeDefined();
    const names = out.tools.map((t) => t.name);
    // Names may be OAuth-prefixed; ensure original name is present somewhere
    expect(names.some((n) => n === "echo" || n.endsWith("echo") || n.includes("echo"))).toBe(true);
    expect(out.tools[0].description).toBe("Echo");
    expect(out.tools[0].name).not.toBe("undefined");
  });
});
