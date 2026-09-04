import { describe, expect, it, vi } from "vitest";

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";

function run(status, contentType, body = "<html><title>Just a moment</title></html>") {
  return handleStreamingResponse({
    providerResponse: new Response(body, { status, headers: { "Content-Type": contentType } }),
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
    onRequestSuccess: vi.fn(),
    streamController: { handleError: vi.fn() },
    reqLogger: {},
  });
}

describe("non-SSE upstream reply status (H14)", () => {
  it("turns an HTTP 200 HTML body into a 502 error, never a 200 error envelope", async () => {
    const result = await run(200, "text/html");
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toContain("Just a moment");
  });

  it("keeps an upstream error status when it already signals failure", async () => {
    const result = await run(503, "text/plain", "overloaded");
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(503);
  });
});
