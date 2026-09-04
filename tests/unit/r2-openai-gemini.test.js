/** Round-2 request-translator findings X1–X10, X68 (openai-to-gemini). */
import { describe, it, expect } from "vitest";
import {
  openaiToGeminiRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { stripOrphanedToolResults } from "../../open-sse/translator/concerns/toolCall.js";

const toolBody = (toolContent, args = '{"city":"x"}') => ({
  messages: [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: args } }],
    },
    { role: "tool", tool_call_id: "call_1", content: toolContent },
  ],
});

const frParts = (out) =>
  out.contents.flatMap((c) => c.parts || []).filter((p) => p.functionResponse);

describe("X1 single-wrap tool responses", () => {
  it("string content maps to exactly one result level", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody("sunny"), true);
    expect(frParts(out)[0].functionResponse.response).toEqual({ result: "sunny" });
  });
  it("JSON-string content unwraps to the object", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody('{"temp":21}'), true);
    expect(frParts(out)[0].functionResponse.response).toEqual({ result: { temp: 21 } });
  });
  it("numeric-string content stays scalar under one result", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody("42"), true);
    expect(frParts(out)[0].functionResponse.response).toEqual({ result: 42 });
  });
  it("empty-string stub maps to empty result", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody(""), true);
    expect(frParts(out)[0].functionResponse.response).toEqual({ result: "" });
  });
});

describe("X2 max token spellings", () => {
  it.each([
    ["max_tokens", { max_tokens: 111 }],
    ["max_completion_tokens", { max_completion_tokens: 222 }],
    ["max_output_tokens", { max_output_tokens: 333 }],
  ])("%s maps to maxOutputTokens", (_name, extra) => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }, true);
    expect(out.generationConfig.maxOutputTokens).toBe(Object.values(extra)[0]);
  });
  it("max_tokens wins over alternates", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1, max_completion_tokens: 2, max_output_tokens: 3,
    }, true);
    expect(out.generationConfig.maxOutputTokens).toBe(1);
  });
});

describe("X3 malformed tool args", () => {
  it("malformed JSON string yields args {}", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody("ok", "not-json{{{"), true);
    const fc = out.contents.flatMap((c) => c.parts || []).find((p) => p.functionCall);
    expect(fc.functionCall.args).toEqual({});
  });
  it("missing arguments yields args {}", () => {
    const body = toolBody("ok");
    delete body.messages[1].tool_calls[0].function.arguments;
    const out = openaiToGeminiRequest("gemini-2.0-flash", body, true);
    const fc = out.contents.flatMap((c) => c.parts || []).find((p) => p.functionCall);
    expect(fc.functionCall.args).toEqual({});
  });
});

describe("X4 stop / response_format", () => {
  it("stop string and array map to stopSequences", () => {
    const s = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }], stop: "END",
    }, true);
    expect(s.generationConfig.stopSequences).toEqual(["END"]);
    const a = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }], stop: ["A", "B"],
    }, true);
    expect(a.generationConfig.stopSequences).toEqual(["A", "B"]);
  });
  it("json_object sets responseMimeType", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    }, true);
    expect(out.generationConfig.responseMimeType).toBe("application/json");
  });
  it("json_schema sets mime type plus cleaned schema", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "r",
          schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
    }, true);
    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.generationConfig.responseSchema.properties.q.type).toBe("string");
  });
});

describe("X5 system separator", () => {
  it("array system content joins with newline", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [
        { role: "system", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
        { role: "user", content: "hi" },
      ],
    }, true);
    expect(out.systemInstruction.parts[0].text).toBe("line1\nline2");
  });
});

// X6 (gate reversal): the Gemini API FunctionCall schema includes `id`, and the
// post-translate orphan strip (chatCore) keys functionResponse on it — dropping
// it from functionCall stripped every tool result. Ids must stay paired.
describe("X6 functionCall keeps its id, paired with functionResponse", () => {
  it("functionCall.id equals functionResponse.id", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", toolBody("ok"), true);
    const parts = out.contents.flatMap((c) => c.parts || []);
    const fc = parts.find((p) => p.functionCall);
    const fr = parts.find((p) => p.functionResponse);
    expect(fc.functionCall.id).toBe("call_1");
    expect(fr.functionResponse.id).toBe("call_1");
  });
  it("tool results survive the pipeline's post-translate orphan strip", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-2.0-flash", toolBody("ok"), true);
    expect(stripOrphanedToolResults(out)).toBe(0);
    expect(frParts(out)).toHaveLength(1);
  });
  it("registry credentials never become a thoughtSignature", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-2.0-flash", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning_content: "hmm" },
        { role: "user", content: "more" },
      ],
    }, true, { apiKey: "sk-secret-should-never-appear" });
    expect(JSON.stringify(out)).not.toContain("sk-secret-should-never-appear");
    const sigs = out.contents.flatMap((c) => c.parts || []).filter((p) => p.thoughtSignature !== undefined);
    expect(sigs.length).toBeGreaterThan(0);
    for (const p of sigs) expect(typeof p.thoughtSignature).toBe("string");
  });
});

describe("X8 claude-path temperature 0", () => {
  const claudeBody = (temperature) => ({
    messages: [{ role: "user", content: "hi" }],
    ...(temperature === undefined ? {} : { temperature }),
  });
  it("0 stays 0", () => {
    const out = openaiToAntigravityRequest("claude-sonnet-4-6", claudeBody(0), true);
    expect(out.request.generationConfig.temperature).toBe(0);
  });
  it("undefined becomes 1", () => {
    const out = openaiToAntigravityRequest("claude-sonnet-4-6", claudeBody(undefined), true);
    expect(out.request.generationConfig.temperature).toBe(1);
  });
});

describe("X9 claude-path tool_choice", () => {
  const tools = [{ type: "function", function: { name: "w", parameters: { type: "object", properties: {} } } }];
  const run = (tool_choice) => openaiToAntigravityRequest("claude-sonnet-4-6", {
    messages: [{ role: "user", content: "hi" }],
    tools,
    ...(tool_choice === undefined ? {} : { tool_choice }),
  }, true).request.toolConfig?.functionCallingConfig;
  it("none → NONE", () => expect(run("none")).toEqual({ mode: "NONE" }));
  it("required → ANY", () => expect(run("required")).toEqual({ mode: "ANY" }));
  it("forced tool → ANY + allowedFunctionNames", () => {
    expect(run({ type: "function", function: { name: "w" } }))
      .toEqual({ mode: "ANY", allowedFunctionNames: ["w"] });
  });
  it("unset defaults to VALIDATED", () => expect(run(undefined)).toEqual({ mode: "VALIDATED" }));
});

describe("X10 claude-model detection", () => {
  it("gemini id containing 'claude' takes the Gemini envelope", () => {
    const out = openaiToAntigravityRequest("gemini-3-claude-tuned", {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    expect(out.userAgent).toBe("antigravity");
    expect(out.requestType).toBe("agent");
    expect(out.request.generationConfig).toBeDefined();
    expect(out.request.contents).toBeDefined();
  });
  it("claude- prefix takes the Claude backend", () => {
    const out = openaiToAntigravityRequest("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    // Claude envelope carries temperature/maxOutputTokens on generationConfig.
    expect(out.request.generationConfig?.maxOutputTokens).toBeDefined();
  });
});

// X68 (gate reversal): parallel_tool_calls is a hint for the NEXT turn; it must
// never rewrite history (dropping calls orphans their results → 400 / data loss).
describe("X68 parallel_tool_calls false never trims gemini history", () => {
  it("both calls survive", () => {
    const body = toolBody("ok");
    body.messages[1].tool_calls.push(
      { id: "call_2", type: "function", function: { name: "other", arguments: "{}" } },
    );
    body.parallel_tool_calls = false;
    const out = openaiToGeminiRequest("gemini-2.0-flash", body, true);
    const fcs = out.contents.flatMap((c) => c.parts || []).filter((p) => p.functionCall);
    expect(fcs).toHaveLength(2);
  });
});
