import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";
import { executeWithPreOutputSseRetry } from "../../open-sse/utils/sseTransientRetry.js";

const TRANSIENT = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"server_is_overloaded\"}}\n\n";
const CREATED = "event: response.created\ndata: {\"type\":\"response.created\"}\n\n";
const OUTPUT = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n";

function response(text, { onCancel } = {}) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      if (!onCancel) controller.close();
    },
    cancel: onCancel,
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function result(text, options) {
  return { response: response(text, options), url: "https://upstream.test/responses", headers: {}, transformedBody: {} };
}

const retryConfig = { 503: { attempts: 1, delayMs: 0 } };

afterEach(() => vi.restoreAllMocks());

describe("pre-output SSE transient retry", () => {
  it("retries a known transient error before output", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(result(CREATED + TRANSIENT))
      .mockResolvedValueOnce(result(OUTPUT));

    const retried = await executeWithPreOutputSseRetry({ execute, retryConfig });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(await retried.response.text()).toBe(OUTPUT);
  });

  it("does not replay after meaningful output and preserves every byte", async () => {
    const original = CREATED + OUTPUT + TRANSIENT;
    const execute = vi.fn().mockResolvedValue(result(original));

    const returned = await executeWithPreOutputSseRetry({ execute, retryConfig });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await returned.response.text()).toBe(original);
  });

  it("returns the final upstream error exactly once when retries are exhausted", async () => {
    const first = `${TRANSIENT}: first`;
    const final = `${TRANSIENT}: final`;
    const execute = vi.fn()
      .mockResolvedValueOnce(result(first))
      .mockResolvedValueOnce(result(final));

    const returned = await executeWithPreOutputSseRetry({ execute, retryConfig });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(await returned.response.text()).toBe(final);
  });

  it("cancels the held response and stops before retry when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const execute = vi.fn().mockResolvedValue(result(TRANSIENT, { onCancel }));
    const pending = executeWithPreOutputSseRetry({
      execute,
      retryConfig: { 503: { attempts: 1, delayMs: 1000 } },
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([
    ["codex", () => new CodexExecutor(), { body: { input: [] }, credentials: {} }],
    ["grok-cli", () => new GrokCliExecutor(), { body: { input: [] }, credentials: { providerSpecificData: { deviceId: "agent" } } }],
  ])("integrates with %s Responses transport", async (_provider, makeExecutor, extra) => {
    const execute = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockResolvedValueOnce(result(TRANSIENT))
      .mockResolvedValueOnce(result(OUTPUT));
    const executor = makeExecutor();
    executor.config = { ...executor.config, retry: retryConfig };

    const returned = await executor.execute({
      model: "model",
      stream: true,
      signal: new AbortController().signal,
      log: {},
      ...extra,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(await returned.response.text()).toBe(OUTPUT);
  });
});

describe("pre-output peek abort and retry slot (H30/H31)", () => {
  it("aborts a never-resolving peek read promptly and cancels the upstream reader", async () => {
    const onCancel = vi.fn();
    const stalled = new Response(new ReadableStream({ start() {}, cancel: onCancel }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const execute = vi.fn().mockResolvedValue({ response: stalled, url: "https://upstream.test", headers: {}, transformedBody: {} });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(executeWithPreOutputSseRetry({ execute, retryConfig, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("reads a dedicated sseTransient slot and falls back to the 503 entry", async () => {
    const dedicated = vi.fn()
      .mockResolvedValueOnce(result(TRANSIENT))
      .mockResolvedValueOnce(result(TRANSIENT))
      .mockResolvedValueOnce(result(OUTPUT));
    const retried = await executeWithPreOutputSseRetry({
      execute: dedicated,
      retryConfig: { 503: { attempts: 0, delayMs: 0 }, sseTransient: { attempts: 2, delayMs: 0 } },
    });
    expect(dedicated).toHaveBeenCalledTimes(3);
    expect(await retried.response.text()).toBe(OUTPUT);

    const fallback = vi.fn()
      .mockResolvedValueOnce(result(TRANSIENT))
      .mockResolvedValueOnce(result(OUTPUT));
    await executeWithPreOutputSseRetry({ execute: fallback, retryConfig: { 503: { attempts: 1, delayMs: 0 } } });
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
