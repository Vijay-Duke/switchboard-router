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

  it("arms O(1) timers for 1 000 chunks", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      setTimeoutSpy.mockClear();
      setIntervalSpy.mockClear();

      const N = 1000;
      const body = new ReadableStream({
        start(controller) {
          for (let i = 0; i < N; i++) {
            controller.enqueue(new TextEncoder().encode(`chunk-${i}\n`));
          }
          controller.close();
        },
      });
      const out = pipeWithDisconnect(
        new Response(body),
        new TransformStream(),
        makeController(),
        null,
        10_000,
        10_000,
      );

      const text = await new Response(out).text();
      expect(text).toContain("chunk-999");
      // One first-chunk timeout + zero per-chunk re-arms; one stall interval.
      expect(setTimeoutSpy.mock.calls.length).toBeLessThanOrEqual(3);
      expect(setIntervalSpy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(0);

      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stall watchdog fires after silence but not while chunks flow", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      let upstream;
      const body = new ReadableStream({
        start(controller) { upstream = controller; },
      });
      const errors = [];
      const controller = makeController();
      const origError = controller.handleError;
      controller.handleError = (error) => { errors.push(error); origError(error); };
      const out = pipeWithDisconnect(
        new Response(body),
        new TransformStream(),
        controller,
        null,
        1000,
        5000,
      );
      const reader = out.getReader();

      upstream.enqueue(enc.encode("a"));
      let result = await reader.read();
      expect(result.done).toBe(false);

      // Keepalive every 500ms stays under the 1 000ms stall budget: no fire.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(500);
        upstream.enqueue(enc.encode(`k${i}`));
        result = await reader.read();
        expect(result.done).toBe(false);
        expect(errors.length).toBe(0);
      }

      // Then silence well past the budget: the interval fires once.
      upstream.enqueue(enc.encode("last"));
      result = await reader.read();
      expect(result.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2500);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toMatch(/stall/);

      await reader.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it("empty guard treats a byte-silent attempt as a stall and retries in-stream", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const warnings = [];
      // Never enqueues and never closes: every read pends until cancelled.
      const pendingBody = new ReadableStream({ start() {} });
      const retryLine = 'data: {"candidates":[{"content":{"parts":[{"text":"recovered"}]},"finishReason":"STOP"}]}\n\n';
      const stream = createEmptyRetryStream({
        body: pendingBody,
        reexecute: async () => new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(retryLine));
            controller.close();
          },
        }),
        signal: new AbortController().signal,
        log: { warn: (...args) => { warnings.push(args.join(" ")); } },
        stallTimeoutMs: 1000,
        baseDelayMs: 500,
      });
      const reader = stream.getReader();
      const chunks = [];
      let done = false;
      const pump = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) { done = true; return; }
          chunks.push(dec.decode(next.value));
        }
      })();

      // 1 000ms trips the stall interval, 500ms covers the retry backoff.
      await vi.advanceTimersByTimeAsync(3000);
      await pump;

      expect(done).toBe(true);
      expect(chunks.join("")).toContain("recovered");
      expect(warnings.some((w) => w.includes("stall"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
