import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

vi.mock("../../open-sse/runtimeDeps.js", () => ({
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();

function chatCompletionStream() {
  const chunks = [
    { id: "chatcmpl-test", created: 1, model: "deepseek/test", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "brief thought" } }] },
    { choices: [{ index: 0, delta: { content: "OK" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunks));
      controller.close();
    },
  });
}

describe("Responses API client over a Chat Completions provider", () => {
  it("returns a completed non-streaming Responses envelope with output", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(chatCompletionStream(), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      provider: "commandcode",
      model: "deepseek/test",
      body: { stream: false },
      stream: false,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      apiKey: null,
      requestId: "test-request",
      clientRawRequest: { endpoint: "/v1/responses" },
      onRequestSuccess: vi.fn(),
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result.success).toBe(true);
    const response = await result.response.json();
    expect(response.status).toBe("completed");
    expect(response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        content: [expect.objectContaining({ type: "output_text", text: "OK" })],
      }),
    ]));
  });
});
