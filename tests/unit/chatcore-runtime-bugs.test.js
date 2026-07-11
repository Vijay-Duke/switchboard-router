import { describe, expect, it, vi } from "vitest";

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

describe("chat core runtime error handling", () => {
  it("converts an SSE stream read failure into a structured gateway error", async () => {
    const result = await handleNonStreamingResponse({
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.error(new Error("upstream stream failed")); },
      }), { headers: { "Content-Type": "text/event-stream" } }),
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

  it("does not mark an account successful for a non-SSE upstream response", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response("challenge", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
      provider: "test-provider",
      model: "test-model",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: true },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "connection",
      apiKey: null,
      requestId: "request",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess,
      streamController: { handleError: vi.fn() },
      reqLogger: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result).toMatchObject({ success: false });
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});
