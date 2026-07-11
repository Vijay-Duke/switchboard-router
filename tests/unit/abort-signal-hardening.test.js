/**
 * Behavioral tests for abort-signal hardening fixes.
 *
 * Finding 1 (AbortSignal timeout merge fallback in clinepassModels.js):
 *   verify local timeout still aborts when a caller signal is present and
 *   AbortSignal.any is unavailable (Node < 20).
 *
 *   Note: the same structural fix was applied to
 *   src/app/api/v1/models/route.js (fetchCompatibleModelIds) but that
 *   function is not exported, so it is not tested directly here.
 *
 * Finding 2 (emptyStreamGuard retry backoff listener cleanup):
 *   verify timer completion removes the abort listener so no dangling
 *   reference to the Promise closure survives.
 */
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Return a fetch mock that rejects when the passed signal aborts. */
function fetchSignalAware(capture) {
  let captureRef = capture;
  if (!captureRef) {
    const box = { signal: null };
    captureRef = box;
  }
  return vi.spyOn(globalThis, "fetch").mockImplementation((_url, opts) => {
    const sig = /** @type {AbortSignal} */ (opts.signal);
    captureRef.signal = sig;
    return new Promise((_, reject) => {
      if (sig.aborted) return reject(new DOMException("Aborted", "AbortError"));
      sig.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
}

function stripAny() {
  const orig = /** @type {any} */ (AbortSignal).any;
  /** @type {any} */ (AbortSignal).any = undefined;
  return orig;
}

// ---------------------------------------------------------------------------
// Finding 1: clinepassModels timeout + callerSignal merge fallback
// ---------------------------------------------------------------------------
describe("clinepassModels abort-signal merge fallback (#LOW)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("local timeout aborts when caller signal present and AbortSignal.any unavailable", async () => {
    const origAny = stripAny();
    const box = { signal: null };
    const fetchMock = fetchSignalAware(box);

    // Mock setTimeout so we can fire the timer synchronously.
    let fireTimer;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb) => { fireTimer = cb; return 1; });
    vi.spyOn(globalThis, "clearTimeout").mockReturnValue(undefined);

    const callerCtrl = new AbortController();
    const promise = (await import("open-sse/services/clinepassModels.js"))
      .resolveClinepassModels({ apiKey: "test-key" }, { signal: callerCtrl.signal });

    expect(fireTimer).toBeDefined();
    fireTimer();

    expect(box.signal).not.toBeNull();
    expect(box.signal.aborted).toBe(true);

    AbortSignal.any = origAny;
    fetchMock.mockRestore();
    await expect(promise).resolves.toBeNull();
  });

  it("timeout works normally when no caller signal and AbortSignal.any unavailable", async () => {
    const origAny = stripAny();
    const box = { signal: null };
    const fetchMock = fetchSignalAware(box);

    let fireTimer;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((cb) => { fireTimer = cb; return 1; });
    vi.spyOn(globalThis, "clearTimeout").mockReturnValue(undefined);

    const promise = (await import("open-sse/services/clinepassModels.js"))
      .resolveClinepassModels({ apiKey: "test-key" });

    expect(fireTimer).toBeDefined();
    fireTimer();

    expect(box.signal).not.toBeNull();
    expect(box.signal.aborted).toBe(true);

    AbortSignal.any = origAny;
    fetchMock.mockRestore();
    await expect(promise).resolves.toBeNull();
  });

  it("AbortSignal.any path still works (smoke)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([
        { id: "cline-pass/glm-5.2", name: "GLM-5.2" },
      ]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const callerSignal = new AbortController().signal;
    const result = await (await import("open-sse/services/clinepassModels.js"))
      .resolveClinepassModels({ apiKey: "test-key" }, { signal: callerSignal });

    expect(result).not.toBeNull();
    expect(result.models.length).toBeGreaterThanOrEqual(1);
    expect(result.models[0].id).toBe("cline-pass/glm-5.2");
  });
});

// ---------------------------------------------------------------------------
// Finding 2: emptyStreamGuard retry backoff listener cleanup
// ---------------------------------------------------------------------------
describe("emptyStreamGuard retry backoff listener cleanup (#LOW)", () => {
  afterAll(() => { vi.useRealTimers(); });

  it("waitForBackoff removes abort listener on timer completion", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const signal = ac.signal;
    const removeSpy = vi.spyOn(signal, "removeEventListener");

    const { waitForBackoff } = await import("open-sse/handlers/chatCore/emptyStreamGuard.js");
    const p = waitForBackoff(signal, 100);

    await vi.advanceTimersByTimeAsync(200);
    await p;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("waitForBackoff resolves immediately on signal abort", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const { waitForBackoff } = await import("open-sse/handlers/chatCore/emptyStreamGuard.js");

    let resolvedVia = null;
    waitForBackoff(controller.signal, 50_000).then(() => { resolvedVia = "abort"; });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(resolvedVia).toBe("abort");
  });

  it("createEmptyRetryStream stops retrying when signal aborts during backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const encoder = new TextEncoder();
    const { createEmptyRetryStream } = await import("open-sse/handlers/chatCore/emptyStreamGuard.js");

    // First attempt: empty (triggers retry).
    const emptyBody = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(
          'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":""}]}}]}}\n\n'
        ));
        ctrl.close();
      },
    });

    const reexecute = vi.fn().mockResolvedValue(new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(
          'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"still empty"}]}}]}}\n\n'
        ));
        ctrl.close();
      },
    }));

    const stream = createEmptyRetryStream({
      body: emptyBody,
      reexecute,
      signal: controller.signal,
      baseDelayMs: 100,
    });

    const reader = stream.getReader();
    const chunks = [];
    let errored = null;

    // Start consuming — backoff begins after empty first attempt.
    const readPromise = (async () => {
      while (true) {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        } catch (e) {
          errored = e;
          break;
        }
      }
    })();

    // Let the first attempt fully process so waitForBackoff starts.
    await vi.advanceTimersByTimeAsync(10);
    // Abort during backoff.
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await readPromise;

    // Stream should error with AbortError, not exhaust retries.
    expect(errored).not.toBeNull();
    expect(errored.name).toBe("AbortError");
    // reexecute should NOT have been called — abort preempted the retry.
    expect(reexecute).not.toHaveBeenCalled();
  });

  it("createEmptyRetryStream removes abort listener after normal completion via backoff then retry", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const encoder = new TextEncoder();
    const { createEmptyRetryStream } = await import("open-sse/handlers/chatCore/emptyStreamGuard.js");

    // First attempt: empty (triggers backoff).
    const emptyBody = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(
          'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":""}]}}]}}\n\n'
        ));
        ctrl.close();
      },
    });

    // Retry attempt: meaningful content.
    const retryBody = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(
          'data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"hello"}]}}]}}\n\n'
        ));
        ctrl.close();
      },
    });

    const reexecute = vi.fn().mockResolvedValue(retryBody);

    const stream = createEmptyRetryStream({
      body: emptyBody,
      reexecute,
      signal: controller.signal,
      baseDelayMs: 100,
    });

    const reader = stream.getReader();
    const chunks = [];

    const readPromise = (async () => {
      while (true) {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        } catch (e) {
          chunks.push({ error: e.message });
          break;
        }
      }
    })();

    // Empty attempt processes → backoff starts.
    await vi.advanceTimersByTimeAsync(10);
    // Timer fires → reexecute runs → retry completes with content.
    await vi.advanceTimersByTimeAsync(200);

    await readPromise;

    // Timer-based completion should have removed the abort listener.
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    // Stream should have completed without error and carried some content.
    expect(chunks.join("")).toContain("hello");
    expect(reexecute).toHaveBeenCalledTimes(1);
  });
});
