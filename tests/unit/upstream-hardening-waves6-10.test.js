/**
 * Regression tests for waves 6–10 gatekeeper fixes.
 */
import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { fixMissingToolResponses, hasToolResults } from "../../open-sse/translator/concerns/toolCall.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";
import { openaiToAntigravityResponse } from "../../open-sse/translator/response/openai-to-antigravity.js";
import { kiroToOpenAIResponse } from "../../open-sse/translator/response/kiro-to-openai.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import { CLAUDE_SYSTEM_PROMPT } from "../../open-sse/config/appConstants.js";

describe("wave6: Claude Code prompt only for OAuth", () => {
  it("does not inject for plain API key / MiniMax-style credentials", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
    }, true, { apiKey: "sk-ant-api03-xxx" });
    const sys = JSON.stringify(out.system || "");
    expect(sys).not.toContain("Claude Code");
  });

  it("injects for sk-ant-oat OAuth token", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
    }, true, { accessToken: "sk-ant-oat-xxx" });
    const sys = JSON.stringify(out.system || "");
    expect(sys).toContain("Claude Code");
  });
});

describe("wave6: responses stream respects flag", () => {
  it("sets stream false when client asks non-stream", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5", {
      messages: [{ role: "user", content: "hi" }],
    }, false, null);
    expect(out.stream).toBe(false);
  });
});

describe("wave7: multi-tool missing results", () => {
  it("inserts only the missing tool id when one of two is present", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "user", content: "continue" },
      ],
    };
    fixMissingToolResponses(body);
    const tools = body.messages.filter((m) => m.role === "tool");
    expect(tools.map((t) => t.tool_call_id).sort()).toEqual(["c1", "c2"]);
  });
});

describe("wave8: gemini schema strips pattern/uniqueItems", () => {
  it("removes pattern and uniqueItems", () => {
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone({
      type: "object",
      properties: {
        s: { type: "string", pattern: "^[a-z]+$" },
        a: { type: "array", uniqueItems: true, items: { type: "string" } },
      },
    }));
    expect(cleaned.properties.s.pattern).toBeUndefined();
    expect(cleaned.properties.a.uniqueItems).toBeUndefined();
  });
});

describe("wave8: no reasoning_content inject on Claude-shaped MiniMax body", () => {
  it("skips Claude tool_use bodies", () => {
    const body = {
      system: "sys",
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
      }],
    };
    const out = injectReasoningContent({
      provider: "minimax",
      model: "MiniMax-M2",
      body,
    });
    expect(out.messages[0].reasoning_content).toBeUndefined();
  });
});

describe("wave9: antigravity tool name not doubled", () => {
  it("does not double name on repeated name deltas", () => {
    const state = { _toolCallAccum: {}, toolNameMap: null };
    openaiToAntigravityResponse({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "" } }] } }],
    }, state);
    openaiToAntigravityResponse({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "{}" } }] } }],
    }, state);
    const fin = openaiToAntigravityResponse({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state);
    const parts = fin?.response?.candidates?.[0]?.content?.parts
      || fin?.candidates?.[0]?.content?.parts
      || [];
    const fc = parts.find((p) => p.functionCall);
    expect(fc?.functionCall?.name).toBe("lookup");
  });
});

describe("H2: antigravity flushes truncated tool calls", () => {
  it("emits buffered functionCall parts and a terminal STOP when finish_reason is missing", () => {
    const state = { _toolCallAccum: {}, toolNameMap: null };
    openaiToAntigravityResponse({
      id: "chatcmpl-truncated-antigravity",
      model: "gpt-test",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-truncated",
            function: { name: "lookup", arguments: '{"q":"x"}' },
          }],
        },
        finish_reason: null,
      }],
    }, state);

    const flushed = openaiToAntigravityResponse(null, state);
    const candidate = flushed.response.candidates[0];
    expect(candidate.content.parts).toContainEqual({
      functionCall: { name: "lookup", args: { q: "x" } },
    });
    expect(candidate.finishReason).toBe("STOP");
    expect(openaiToAntigravityResponse(null, state)).toBeNull();
  });
});

describe("wave9: kiro multi-tool index", () => {
  it("assigns distinct indices", () => {
    const state = { chunkIndex: 0 };
    const a = kiroToOpenAIResponse({ toolUseEvent: { toolUseId: "t1", name: "a", input: {} } }, state);
    const b = kiroToOpenAIResponse({ toolUseEvent: { toolUseId: "t2", name: "b", input: {} } }, state);
    expect(a.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(b.choices[0].delta.tool_calls[0].index).toBe(1);
  });
});

describe("wave10: claude tool_choice none → openai none", () => {
  it("maps none correctly", () => {
    const out = claudeToOpenAIRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "x", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "none" },
    }, true);
    expect(out.tool_choice).toBe("none");
  });

  it("filterToOpenAIFormat preserves none", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" },
    };
    filterToOpenAIFormat(body);
    expect(body.tool_choice).toBe("none");
  });
});

describe("wave10: gemini tool_choice mapping", () => {
  it("maps none to functionCallingConfig NONE", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    }, true);
    expect(out.toolConfig?.functionCallingConfig?.mode).toBe("NONE");
  });
});

describe("wave10: tool_use input never string", () => {
  it("uses {} for invalid JSON args", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{
            id: "c1",
            type: "function",
            function: { name: "x", arguments: "not-json{{{" },
          }],
        },
      ],
    }, true, null);
    const asst = out.messages.find((m) => m.role === "assistant");
    const toolUse = asst.content.find((b) => b.type === "tool_use");
    expect(typeof toolUse.input).toBe("object");
    expect(Array.isArray(toolUse.input) || toolUse.input !== null).toBe(true);
  });
});
