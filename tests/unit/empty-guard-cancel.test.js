import { describe, expect, it, vi } from "vitest";

import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const encoder = new TextEncoder();

// Gemini 200 with a bare STOP and no text: classified as an empty attempt.
const EMPTY_STOP = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}]}\n\n";

function emptyAttempt() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(EMPTY_STOP));
      controller.close();
    },
  });
}

describe("empty-stream guard honors downstream cancel (H25)", () => {
  it("does not re-execute upstream when the client cancels during backoff", async () => {
    const reexecute = vi.fn(async () => emptyAttempt());
    const stream = createEmptyRetryStream({
      body: emptyAttempt(),
      reexecute,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
      stallTimeoutMs: 1000,
      baseDelayMs: 40,
    });
    const reader = stream.getReader();

    // Let the first attempt drain and enter backoff, then walk away.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reader.cancel("client gone");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(reexecute).not.toHaveBeenCalled();
  });

  it("still retries when the client is listening", async () => {
    const reexecute = vi.fn(async () => new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"answer\"}]},\"finishReason\":\"STOP\"}]}\n\n"));
        controller.close();
      },
    }));
    const stream = createEmptyRetryStream({
      body: emptyAttempt(),
      reexecute,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
      stallTimeoutMs: 1000,
      baseDelayMs: 5,
    });
    const text = await new Response(stream).text();
    expect(reexecute).toHaveBeenCalledTimes(1);
    expect(text).toContain("answer");
  });
});
