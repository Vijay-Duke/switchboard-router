import { afterEach, describe, expect, it, vi } from "vitest";

import { handleNonStreamingResponse, translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function gemini(finishReason, parts = [{ text: "hi" }]) {
  return { candidates: [{ content: { parts }, finishReason }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
}

describe("Gemini non-stream projection (H19)", () => {
  it("emits deterministic tool-call ids", () => {
    const parts = [
      { functionCall: { name: "get_weather", args: { city: "Perth" } } },
      { functionCall: { name: "get_time", args: {} } },
    ];
    const a = translateNonStreamingResponse(gemini("STOP", parts), FORMATS.GEMINI);
    const b = translateNonStreamingResponse(gemini("STOP", parts), FORMATS.GEMINI);
    expect(a.choices[0].message.tool_calls.map((t) => t.id)).toEqual(["call_get_weather_0", "call_get_time_1"]);
    expect(a.choices[0].message.tool_calls.map((t) => t.id)).toEqual(b.choices[0].message.tool_calls.map((t) => t.id));
    expect(a.choices[0].finish_reason).toBe("tool_calls");
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "content_filter"],
    ["RECITATION", "content_filter"],
    ["BLOCKLIST", "content_filter"],
    ["PROHIBITED_CONTENT", "content_filter"],
    ["MALFORMED_FUNCTION_CALL", "stop"],
    [undefined, "stop"],
  ])("maps Gemini finish reason %s to the OpenAI enum %s", (raw, expected) => {
    expect(translateNonStreamingResponse(gemini(raw), FORMATS.GEMINI).choices[0].finish_reason).toBe(expected);
  });
});

describe("Claude non-stream fence stripping (H20)", () => {
  function claude(text) {
    return { id: "msg", model: "claude", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  }

  it("unwraps a fenced JSON block", () => {
    const out = translateNonStreamingResponse(claude("```json\n{\"a\":1}\n```"), FORMATS.CLAUDE);
    expect(out.choices[0].message.content).toBe("{\"a\":1}");
  });

  it("keeps fences around a code sample that is not JSON", () => {
    const sample = "```json\n// example config\n{ a: 1, }\n```";
    const out = translateNonStreamingResponse(claude(sample), FORMATS.CLAUDE);
    expect(out.choices[0].message.content).toBe(sample);
  });
});

describe("non-stream JSON body bound (H21)", () => {
  afterEach(() => {
    delete process.env.STREAM_TO_JSON_MAX_BYTES;
  });

  it("fails fast with 502 and stops reading an oversized chunked body", async () => {
    process.env.STREAM_TO_JSON_MAX_BYTES = "64";
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("{\"pad\":\"" + "x".repeat(40) + "\","));
      },
      cancel,
    });

    const result = await handleNonStreamingResponse({
      providerResponse: new Response(body, { headers: { "Content-Type": "application/json" } }),
      provider: "test-provider",
      model: "test-model",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "connection",
      apiKey: null,
      requestId: "request",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      reqLogger: { logProviderResponse: vi.fn() },
    });

    expect(result).toMatchObject({ success: false, status: 502 });
    expect(pulls).toBeLessThan(10);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects an oversized declared content-length before reading", async () => {
    process.env.STREAM_TO_JSON_MAX_BYTES = "64";
    const result = await handleNonStreamingResponse({
      providerResponse: new Response("{\"ok\":true}", { headers: { "Content-Type": "application/json", "content-length": "999999" } }),
      provider: "test-provider",
      model: "test-model",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "connection",
      apiKey: null,
      requestId: "request",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      reqLogger: { logProviderResponse: vi.fn() },
    });
    expect(result).toMatchObject({ success: false, status: 502 });
  });
});
