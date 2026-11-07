// A stream aborted after HTTP 200 (stall/abort) must end with a terminal in the
// CLIENT's wire format, including translated routes. (ported from upstream 93001213)
import { describe, it, expect, vi } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

async function abortMidStream(sourceFormat, targetFormat) {
  const enc = new TextEncoder();
  const providerResponse = new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "par" } }] })}\n\n`)); },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const streamController = createStreamController({});
  const result = await handleStreamingResponse({
    providerResponse, provider: "openai", model: "gpt-5", sourceFormat, targetFormat,
    body: { stream: true }, stream: true, translatedBody: {}, finalBody: {}, requestStartTime: Date.now(),
    connectionId: "c", requestId: "r", clientRawRequest: {}, onRequestSuccess: vi.fn(), streamController, reqLogger: {},
  });
  const reader = result.response.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  const first = await reader.read();
  out += dec.decode(first.value);
  streamController.handleError(new Error("stream stall timeout"));
  streamController.abort();
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value); }
  return out;
}

describe("abort terminal follows the client format", () => {
  it("Claude client behind an OpenAI upstream gets event: error, not a chat-completions chunk", async () => {
    const out = await abortMidStream("claude", "openai");
    expect(out).toContain("event: error");
    expect(out).not.toContain("stream_timeout");
  });

  it("OpenAI client keeps the stream_timeout chunk + [DONE]", async () => {
    const out = await abortMidStream("openai", "openai");
    expect(out).toContain("stream_timeout");
    expect(out).toContain("data: [DONE]");
  });
});
