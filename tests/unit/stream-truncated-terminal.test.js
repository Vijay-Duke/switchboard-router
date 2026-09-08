import { describe, expect, it } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedChatCompletionsTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";

function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

function bodyFrom(chunks, { contentType = "text/event-stream" } = {}) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { headers: { "content-type": contentType } }
  );
}

async function collect(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value);
  }
  return out;
}

describe("truncated stream terminal (upstream sends bytes then clean EOF)", () => {
  it("emits stream_timeout terminal when upstream closes mid-stream without a finish marker", async () => {
    // Partial chunk, no finish_reason / [DONE] — overloaded provider reset.
    const providerResponse = bodyFrom([
      `data: {"choices":[{"delta":{"content":"thinking..."}}]}\n\n`,
    ]);
    const identity = new TransformStream();
    const out = await collect(
      pipeWithDisconnect(providerResponse, identity, makeController(), buildAbortedChatCompletionsTerminalBytes, 45000, 0)
    );
    expect(out).toContain("stream_timeout");
    expect(out).toContain("[DONE]");
  });

  it("does NOT emit a terminal on a normal completion that carries finish_reason", async () => {
    const providerResponse = bodyFrom([
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const identity = new TransformStream();
    const out = await collect(
      pipeWithDisconnect(providerResponse, identity, makeController(), buildAbortedChatCompletionsTerminalBytes, 45000, 0)
    );
    expect(out).toContain("finish_reason");
    expect(out).toContain("[DONE]");
    expect(out).not.toContain("stream_timeout");
  });

  it("does NOT emit a terminal on an empty stream (zero-byte path owns that)", async () => {
    const providerResponse = bodyFrom([]);
    const identity = new TransformStream();
    const out = await collect(
      pipeWithDisconnect(providerResponse, identity, makeController(), buildAbortedChatCompletionsTerminalBytes, 45000, 0)
    );
    // empty: no bytes forwarded, so the bare-done terminal is skipped (the
    // zero-byte re-hit / error path handles the empty case upstream).
    expect(out).not.toContain("stream_timeout");
  });
});
