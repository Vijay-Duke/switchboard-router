import { afterEach, expect, it, vi } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { buildAbortedClaudeTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { createZeroByteRetryStream } from "../../open-sse/handlers/chatCore/zeroByteRetryStream.js";
import { handleStreamingResponse, buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { setOpenSseDeps } from "../../open-sse/runtimeDeps.js";

const enc = new TextEncoder();
const frame = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
afterEach(() => vi.useRealTimers());

it("settles a stalled native Claude read even when the upstream ignores abort", async () => {
  vi.useFakeTimers();
  const upstream = new ReadableStream({
    start(c) { c.enqueue(enc.encode(frame({ type: "message_start", message: { usage: { input_tokens: 1 } } }))); },
    cancel() { return new Promise(() => {}); },
  });
  const ctrl = createStreamController({ provider: "claude", model: "test" });
  const stream = pipeWithDisconnect(new Response(upstream), new TransformStream(), ctrl, buildAbortedClaudeTerminalBytes, 50, 0);
  const reader = stream.getReader();
  await reader.read();
  let result;
  const pending = reader.read().then(r => { result = r; });
  await vi.advanceTimersByTimeAsync(60);
  expect(result, "timeout must settle the client read independently of upstream cleanup").toBeDefined();
  expect(new TextDecoder().decode(result.value)).toContain("event: error");
  await pending;
  expect((await reader.read()).done).toBe(true);
});

it("bounds zero-byte failure when upstream cancellation never settles", async () => {
  vi.useFakeTimers();
  const ctrl = new AbortController();
  const stream = createZeroByteRetryStream({
    body: new ReadableStream({ cancel() { return new Promise(() => {}); } }),
    reexecute: vi.fn(), signal: ctrl.signal, firstChunkTimeoutMs: 50, maxRetries: 0,
  });
  let result;
  stream.getReader().read().catch(e => { result = e; });
  await vi.advanceTimersByTimeAsync(60);
  expect(result).toBeInstanceOf(Error);
  expect(result.message).toMatch(/first-chunk timeout/);
});

it("finishes native Claude on message_stop without waiting for upstream EOF", async () => {
  const complete = vi.fn(async () => {});
  const cancel = vi.fn();
  const upstream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(frame({ type: "content_block_delta", delta: { type: "text_delta", text: "saved answer" } }) + frame({ type: "message_delta", usage: { output_tokens: 3 } }) + frame({ type: "message_stop" })));
    }, cancel,
  });
  const out = upstream.pipeThrough(createPassthroughStreamWithLogger("claude", null, null, "test", "connection", {}, complete));
  const reader = out.getReader();
  let text = "", done = false;
  for (let i = 0; i < 4; i++) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    text += new TextDecoder().decode(r.value);
  }
  // The completion hook must run before a CLI disconnects after message_stop.
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][0]).toMatchObject({ content: "saved answer", completed: true });
  expect(text).toContain("message_stop");
  expect(done).toBe(true);
  expect(text).not.toContain("[DONE]");
  await new Promise(resolve => setImmediate(resolve));
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("records native error events as failures instead of success on EOF", async () => {
  const complete = vi.fn(async () => {});
  const upstream = new ReadableStream({ start(c) { c.enqueue(enc.encode(frame({ type: "error", error: { type: "overloaded_error", message: "busy" } }))); c.close(); } });
  await new Response(upstream.pipeThrough(createPassthroughStreamWithLogger("claude", null, null, "test", "connection", {}, complete))).text();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][0]).toMatchObject({ completed: false, error: "busy" });
});

it("marks a truncated native Claude EOF as error, without a synthetic message_stop", async () => {
  const complete = vi.fn(async () => {});
  const upstream = new ReadableStream({ start(c) { c.enqueue(enc.encode(frame({ type: "message_start", message: { usage: { input_tokens: 1 } } }))); c.close(); } });
  const text = await new Response(upstream.pipeThrough(createPassthroughStreamWithLogger("claude", null, null, "test", "connection", {}, complete))).text();
  expect(text).toContain("event: error");
  expect(text).not.toContain("event: message_stop");
  expect(complete.mock.calls[0][0].completed).toBe(false);
});

it.each(["message_stop", "error"])("persists pending then terminal status for %s without awaiting EOF", async (terminal) => {
  const records = [];
  let release;
  const saved = new Promise(resolve => { release = resolve; });
  setOpenSseDeps({
    saveRequestDetail: async (d) => { records.push(d); if (records.length === 1) await saved; },
  });
  const ctx = { provider: "claude", model: "test", body: { messages: [] }, stream: true, requestStartTime: Date.now(), sourceFormat: "claude", targetFormat: "claude" };
  const callbacks = buildOnStreamComplete(ctx);
  const upstream = new ReadableStream({ start(c) { c.enqueue(enc.encode(frame({ type: terminal, error: terminal === "error" ? { type: "overloaded_error", message: "busy" } : undefined }))); } });
  const result = await handleStreamingResponse({ ...ctx, ...callbacks, streamController: createStreamController({ provider: "claude" }), providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  const text = await result.response.text();
  expect(text.match(new RegExp(`event: ${terminal}`, "g"))).toHaveLength(1);
  expect(records.map(d => d.status)).toEqual(["pending"]);
  release();
  await new Promise(resolve => setImmediate(resolve));
  expect(records.map(d => d.status)).toEqual(["pending", terminal === "error" ? "error" : "success"]);
  expect(records[0].id).toBe(records[1].id);
  setOpenSseDeps({ saveRequestDetail: async () => {} });
});

it("finalizes an already-disconnected request instead of retaining a pending record", async () => {
  vi.useFakeTimers();
  const failed = vi.fn();
  const ctrl = createStreamController({ provider: "claude" });
  ctrl.handleError(new Error("caller already left"));
  const out = pipeWithDisconnect(new Response(new ReadableStream()), new TransformStream(), ctrl, buildAbortedClaudeTerminalBytes, 1000, 1000, failed);
  expect(await new Response(out).text()).toContain("event: error");
  expect(failed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("bounds a native Claude stream kept alive only by pings (content started: %s)", async (started) => {
  vi.useFakeTimers();
  const records = [];
  setOpenSseDeps({ saveRequestDetail: async (d) => { records.push(d); } });
  let source;
  const cancel = vi.fn();
  const upstream = new ReadableStream({ start(c) {
    source = c;
    c.enqueue(enc.encode(frame({ type: "message_start", message: { usage: { input_tokens: 1 } } })));
    if (started) c.enqueue(enc.encode(frame({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } })));
  }, cancel });
  const ctx = { provider: "claude", model: "test", body: { messages: [] }, stream: true, requestStartTime: Date.now(), sourceFormat: "claude", targetFormat: "claude", firstProgressTimeoutMs: 50, progressStallTimeoutMs: 50 };
  const result = await handleStreamingResponse({ ...ctx, ...buildOnStreamComplete(ctx), streamController: createStreamController({ provider: "claude" }), providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  let text;
  result.response.text().then(value => { text = value; });
  for (let i = 0; i < 6; i++) {
    source.enqueue(enc.encode(frame({ type: "ping" })));
    await vi.advanceTimersByTimeAsync(10);
    if (text !== undefined) break;
  }
  expect(text, "pings must not extend a model progress deadline").toBeDefined();
  expect(text).toContain("event: error");
  expect(text).not.toContain("event: message_stop");
  expect(records.map(r => r.status)).toEqual(["pending", "error"]);
  expect(records[1].response.error).toMatch(/progress timeout/);
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  setOpenSseDeps({ saveRequestDetail: async () => {} });
});

it("lets continuing native Claude thinking pass the progress deadline and complete", async () => {
  vi.useFakeTimers();
  const records = [];
  setOpenSseDeps({ saveRequestDetail: async d => { records.push(d); } });
  let source;
  const upstream = new ReadableStream({ start(c) { source = c; c.enqueue(enc.encode(frame({ type: "message_start" }))); } });
  const ctx = { provider: "claude", model: "test", body: { messages: [] }, stream: true, requestStartTime: Date.now(), sourceFormat: "claude", targetFormat: "claude", firstProgressTimeoutMs: 50, progressStallTimeoutMs: 50 };
  const result = await handleStreamingResponse({ ...ctx, ...buildOnStreamComplete(ctx), streamController: createStreamController({ provider: "claude" }), providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  const text = result.response.text();
  for (let i = 0; i < 5; i++) {
    source.enqueue(enc.encode(frame({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reasoning" } })));
    await vi.advanceTimersByTimeAsync(40);
  }
  source.enqueue(enc.encode(frame({ type: "message_delta", usage: { output_tokens: 1 } }) + frame({ type: "message_stop" })));
  expect(await text).not.toContain("event: error");
  await vi.advanceTimersByTimeAsync(0);
  expect(records.map(r => r.status)).toEqual(["pending", "success"]);
  expect(vi.getTimerCount()).toBe(0);
  setOpenSseDeps({ saveRequestDetail: async () => {} });
});

it("finalizes caller cancellation while downstream is not reading and upstream cleanup hangs", async () => {
  vi.useFakeTimers();
  const records = [];
  setOpenSseDeps({ saveRequestDetail: async d => { records.push(d); } });
  const upstream = new ReadableStream({ start(c) {
    c.enqueue(enc.encode(frame({ type: "message_start" })));
    c.enqueue(enc.encode(frame({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } })));
  }, cancel() { return new Promise(() => {}); } });
  const ctrl = createStreamController({ provider: "claude" });
  const ctx = { provider: "claude", model: "test", body: { messages: [] }, stream: true, requestStartTime: Date.now(), sourceFormat: "claude", targetFormat: "claude" };
  const result = await handleStreamingResponse({ ...ctx, ...buildOnStreamComplete(ctx), streamController: ctrl, providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  const reader = result.response.body.getReader();
  await reader.read();
  await vi.advanceTimersByTimeAsync(0);
  ctrl.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(records.map(r => r.status)).toEqual(["pending", "error"]);
  expect(ctrl.isConnected()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await reader.cancel();
  setOpenSseDeps({ saveRequestDetail: async () => {} });
});
