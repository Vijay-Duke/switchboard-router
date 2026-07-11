import { afterEach, describe, expect, it, vi } from "vitest";

import { dedupRefresh } from "../../open-sse/services/tokenRefresh/dedup.js";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("token refresh dedup cleanup", () => {
  it("evicts successful credential results instead of retaining a process-lifetime timerless entry", async () => {
    vi.useFakeTimers();
    let calls = 0;

    await dedupRefresh("cleanup-test", "old-token", async () => {
      calls++;
      return { accessToken: "new-token" };
    });

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);

    const refreshed = await dedupRefresh("cleanup-test", "old-token", async () => {
      calls++;
      return { accessToken: "rotated-token" };
    });
    expect(refreshed.accessToken).toBe("rotated-token");
    expect(calls).toBe(2);
  });
});

describe("stream robustness", () => {
  it("fails a 200 SSE response with a null body instead of reporting success", async () => {
    const providerResponse = new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const transformed = pipeWithDisconnect(
      providerResponse,
      new TransformStream(),
      makeController(),
      null,
      1000,
      1000,
    );

    await expect(new Response(transformed).text()).rejects.toThrow("upstream response missing body");
  });

  it("does not read ahead when the downstream reader applies backpressure", async () => {
    const signal = new AbortController();
    const chunk = new TextEncoder().encode(
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"}]}}]}\n',
    );
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls <= 50) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const stream = createEmptyRetryStream({
      body,
      reexecute: async () => new ReadableStream(),
      signal: signal.signal,
      baseDelayMs: 100_000,
      stallTimeoutMs: 1000,
    });
    const reader = stream.getReader();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pulls).toBeLessThan(10);
    signal.abort();
    await reader.cancel();
  });
});
