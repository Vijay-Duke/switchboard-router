import { describe, expect, it } from "vitest";

import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Regression: non-streaming responses from an OpenAI Responses-API provider
// (apiType:"responses") arrive as { output: [...] } with no `choices`. The
// non-stream path must project them to OpenAI chat.completion shape, or the
// model-test button shows a false "no completion choices" error and real
// non-streaming clients receive an empty completion.
describe("non-streaming OpenAI Responses projection", () => {
  const responsesBody = {
    id: "resp_123",
    model: "bedrock/google.gemma-3-27b-it",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello there" }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };

  it("projects { output } to a choices array", () => {
    const result = translateNonStreamingResponse(responsesBody, FORMATS.OPENAI_RESPONSES);
    expect(Array.isArray(result.choices)).toBe(true);
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe("hello there");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(5);
    expect(result.usage.completion_tokens).toBe(2);
  });

  it("passes through a body that is already OpenAI-shaped (SSE-converted)", () => {
    const alreadyOpenAI = {
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const result = translateNonStreamingResponse(alreadyOpenAI, FORMATS.OPENAI_RESPONSES);
    expect(result).toBe(alreadyOpenAI);
  });

  it("returns the body unchanged when it is neither choices- nor output-shaped", () => {
    const weird = { foo: "bar" };
    expect(translateNonStreamingResponse(weird, FORMATS.OPENAI_RESPONSES)).toBe(weird);
  });

  it("projects a tool call to tool_calls with finish_reason tool_calls", () => {
    const withTool = {
      id: "resp_9",
      model: "m",
      status: "completed",
      output: [
        { type: "function_call", call_id: "c1", name: "get_weather", arguments: "{\"city\":\"x\"}" },
      ],
    };
    const result = translateNonStreamingResponse(withTool, FORMATS.OPENAI_RESPONSES);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
  });
});
