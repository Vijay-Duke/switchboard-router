import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor, __resetCodexWsBreakerForTests } from "../../open-sse/executors/codex.js";
import { streamResponsesOverWebSocket } from "../../open-sse/executors/codexWsTransport.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// Lets one test force getDispatcher to throw without replacing the module:
// the mock delegates to the real implementation otherwise, so the other
// tests keep exercising the real proxy/identity code.
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDispatcher: async (...args) => {
      if (globalThis.__codexWsForceDispatcherError) throw new Error("dispatcher boom");
      return actual.getDispatcher(...args);
    },
  };
});

class FakeWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.open?.();
    });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.closed = true; }
  // test-side drivers
  serverOpen() { this.onopen?.(); }
  serverMessage(text) { this.onmessage?.({ data: text }); }
  serverClose() { this.onclose?.(); }
  serverError() { this.onerror?.(); }
}
FakeWebSocket.instances = [];

function makeRequest() {
  return { model: "gpt-5.6-sol", instructions: "be brief", input: [], stream: true, store: false };
}

async function readBody(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}
const savedVitestFlag = process.env.VITEST;
const savedGlobalWebSocket = globalThis.WebSocket;

afterEach(() => {
  delete process.env.CODEX_WS_TRANSPORT;
  delete process.env.HTTPS_PROXY;
  delete globalThis.__codexWsForceDispatcherError;
  if (savedVitestFlag === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitestFlag;
  globalThis.WebSocket = savedGlobalWebSocket;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Drive _executeOverWebSocket for real: opt out of the VITEST short-circuit
// and route the global WebSocket constructor to the fake.
function runWithFakeWebSocket() {
  delete process.env.VITEST;
  globalThis.WebSocket = FakeWebSocket;
}

// Wait for the next socket created after previousCount (each attempt makes
// at most one). Waiting on total length alone replays a stale socket when a
// test drives several attempts in a row.
async function waitForNewWs(previousCount) {
  for (let i = 0; i < 1000 && FakeWebSocket.instances.length <= previousCount; i++) await Promise.resolve();
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

async function executeAndWaitForWs(executor, args) {
  const previousCount = FakeWebSocket.instances.length;
  const pending = executor.execute(args);
  const ws = await waitForNewWs(previousCount);
  return { pending, ws };
}

function newExecutorWithHttpMock() {
  __resetCodexWsBreakerForTests();
  FakeWebSocket.instances.length = 0;
  runWithFakeWebSocket();
  const executor = new CodexExecutor();
  vi.spyOn(executor, "prefetchImages").mockResolvedValue();
  const calls = [];
  const httpExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute").mockImplementation(async (args) => {
    calls.push(args);
    return { response: new Response("http") };
  });
  return { executor, httpExecute, calls };
}

it("uses WebSocket by default and permits an explicit HTTP fallback", async () => {
  const executor = new CodexExecutor();
  const execute = vi.spyOn(executor, "_executeOverWebSocket").mockResolvedValue(null);
  vi.spyOn(executor, "prefetchImages").mockResolvedValue();
  vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute").mockResolvedValue({ response: new Response() });

  await executor.execute({ body: { input: [] }, stream: true });
  expect(execute).toHaveBeenCalledOnce();

  process.env.CODEX_WS_TRANSPORT = "off";
  execute.mockClear();
  await executor.execute({ body: { input: [] }, stream: true });
  expect(execute).not.toHaveBeenCalled();
});

it("returns the successful opt-in WebSocket execution without HTTP fallback", async () => {
  process.env.CODEX_WS_TRANSPORT = "on";
  const executor = new CodexExecutor();
  vi.spyOn(executor, "prefetchImages").mockResolvedValue();
  const websocketResult = { response: new Response("ws") };
  vi.spyOn(executor, "_executeOverWebSocket").mockResolvedValue(websocketResult);
  const httpExecute = vi.spyOn(Object.getPrototypeOf(CodexExecutor.prototype), "execute").mockResolvedValue({ response: new Response("http") });

  const result = await executor.execute({ body: { input: [] }, stream: true });

  expect(result).toBe(websocketResult);
  expect(httpExecute).not.toHaveBeenCalled();
});
describe("codex responses_websocket transport", () => {

  it("wraps the request as response.create and bridges frames to SSE bytes", async () => {
    FakeWebSocket.instances.length = 0;
    const { response } = streamResponsesOverWebSocket({
      wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
      headers: { originator: "codex_cli_rs" },
      request: makeRequest(),
      WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();

    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "response.create", model: "gpt-5.6-sol", stream: true });
    expect(ws.options.headers).toMatchObject({ originator: "codex_cli_rs" });

    const done = readBody(response.body);
    ws.serverMessage('{"type":"response.created","response":{"id":"resp_1"}}');
    ws.serverMessage('{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}');
    const text = await done;

    expect(text).toContain("event: response.created");
    expect(text).toContain('"type":"response.created"');
    expect(text).toContain("event: response.completed");
    // terminal closes the client stream and the socket
    expect(ws.closed).toBe(true);
  });

  it("survives downstream termination after the terminal frame", async () => {
    FakeWebSocket.instances.length = 0;
    const { response } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const output = response.body.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "codex", null, null, "gpt-5.6-sol",
    ));
    const done = readBody(output);

    ws.serverMessage('{"type":"response.created","response":{"id":"resp_1"}}');
    ws.serverMessage('{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}');
    ws.serverMessage('{"type":"response.output_text.delta","delta":"late"}');

    await expect(done).resolves.toContain("data: [DONE]");
  });

  it("lets WebSocket EOF close the transform without cancelling upstream", async () => {
    const encoder = new TextEncoder();
    let sourceController;
    let cancelled = false;
    const source = new ReadableStream({
      start(controller) { sourceController = controller; },
      cancel() { cancelled = true; },
    });
    const output = source.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "codex", null, null, "gpt-5.6-sol",
      null, null, null, null, false,
    ));
    const reader = output.getReader();

    sourceController.enqueue(encoder.encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ));
    const first = await reader.read();
    const second = await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value)).toContain("data: [DONE]");
    expect(cancelled).toBe(false);

    sourceController.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("emits error frames as SSE events and ends the stream", async () => {
    FakeWebSocket.instances.length = 0;
    const { response, ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const done = readBody(response.body);
    // The first frame settles ready; later error frames stream as events.
    ws.serverMessage('{"type":"response.created","response":{"id":"resp_1"}}');
    await ready;
    ws.serverMessage('{"type":"error","status":429,"error":{"message":"rate limited"}}');
    const text = await done;

    expect(text).toContain("event: response.created");
    expect(text).toContain("event: error");
    expect(text).toContain("rate limited");
    expect(ws.closed).toBe(true);
  });

  it("errors the client stream when the socket closes before a terminal event", async () => {
    FakeWebSocket.instances.length = 0;
    const { response } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const read = response.body.getReader();
    ws.serverMessage('{"type":"response.created"}');
    await read.read();
    ws.serverClose();

    await expect(read.read()).rejects.toThrow(/closed before terminal/i);
  });

  it("closes the socket when the abort signal fires", async () => {
    FakeWebSocket.instances.length = 0;
    const ctrl = new AbortController();
    const { ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket, signal: ctrl.signal,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    // Aborting before the first frame rejects ready (nothing settles it).
    const assertion = expect(ready).rejects.toThrow(/abort/i);
    ctrl.abort();

    await assertion;
    expect(ws.closed).toBe(true);
  });

  it("disposes a socket when the handshake fails", async () => {
    FakeWebSocket.instances.length = 0;
    const { ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverError();

    await expect(ready).rejects.toThrow(/handshake failed/i);
    expect(ws.closed).toBe(true);
  });

  it("rejects ready on a first-frame error without emitting it", async () => {
    FakeWebSocket.instances.length = 0;
    const { response, ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const assertion = expect(ready).rejects.toMatchObject({ status: 429, code: "codex_ws_error_frame" });
    ws.serverMessage('{"type":"error","status":429,"error":{"message":"quota exhausted"}}');
    await assertion;
    expect(ws.closed).toBe(true);
    await expect(readBody(response.body)).rejects.toThrow(/quota exhausted/);
  });

  it("rejects ready when no frame arrives before the connect timeout", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      const { ready } = streamResponsesOverWebSocket({
        wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
      });
      const ws = FakeWebSocket.instances[0];
      ws.serverOpen();
      const assertion = expect(ready).rejects.toMatchObject({ code: "codex_ws_timeout" });
      await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS);
      await assertion;
      expect(ws.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects ready on connect timeout when onopen never fires", async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      const { ready } = streamResponsesOverWebSocket({
        wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
      });
      const ws = FakeWebSocket.instances[0];
      const assertion = expect(ready).rejects.toMatchObject({ code: "codex_ws_timeout" });
      await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS);
      await assertion;
      expect(ws.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers frames without demand and delivers all in order once read", async () => {
    FakeWebSocket.instances.length = 0;
    const { response, ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    // Nobody reads while 100 frames arrive: they must wait off-stream, not
    // accumulate in the ReadableStream queue, and none may be lost.
    for (let i = 0; i < 100; i++) {
      ws.serverMessage(`{"type":"response.output_text.delta","delta":"${i}"}`);
    }
    await ready;
    ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
    const text = await readBody(response.body);
    const deltas = [...text.matchAll(/"delta":"(\d+)"/g)].map((m) => Number(m[1]));
    expect(deltas).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(text).toContain("event: response.completed");
    expect(ws.closed).toBe(true);
  });

  describe("codex executor websocket fallback", () => {
    it("falls back to HTTP when the first frame is an error", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      expect(ws).toBeDefined();
      ws.serverOpen();
      ws.serverMessage('{"type":"error","status":429,"error":{"message":"quota exhausted"}}');
      const result = await pending;
      expect(httpExecute).toHaveBeenCalledOnce();
      await expect(result.response.text()).resolves.toBe("http");
    });

    it("passes a proxy dispatcher to the WebSocket when a connection proxy is configured", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      const { pending, ws } = await executeAndWaitForWs(executor, {
        model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {},
        proxyOptions: { enabled: true, url: "http://127.0.0.1:1" },
      });
      expect(ws.options.dispatcher).toBeDefined();
      ws.serverOpen();
      ws.serverMessage('{"type":"response.created","response":{"id":"resp_1"}}');
      ws.serverMessage('{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}');
      const result = await pending;
      expect(httpExecute).not.toHaveBeenCalled();
      expect(result.response.status).toBe(200);
    });

    it("falls back to HTTP under strictProxy when the dispatcher cannot be built", async () => {
      globalThis.__codexWsForceDispatcherError = true;
      const { executor, httpExecute } = newExecutorWithHttpMock();
      const result = await executor.execute({
        model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {},
        proxyOptions: { enabled: true, url: "http://127.0.0.1:1", strictProxy: true },
      });
      expect(FakeWebSocket.instances.length).toBe(0);
      expect(httpExecute).toHaveBeenCalledOnce();
      await expect(result.response.text()).resolves.toBe("http");
    });

    it("wraps upgrade headers with the codex-cli identity", async () => {
      const { executor } = newExecutorWithHttpMock();
      const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      const headers = ws.options.headers;
      const { headers: expected } = wrapHeaders({}, {
        identity: executor.config.identity,
        provider: "codex",
        format: executor.config.format,
        stream: true,
      });
      expect(headers["User-Agent"]).toBe(expected["User-Agent"]);
      expect(headers["User-Agent"]).toMatch(/codex_cli_rs\//);
      expect(headers["User-Agent"]).not.toBe("node");
      for (const [key, value] of Object.entries(headers)) {
        expect(`${key}: ${value}`).not.toMatch(/switchboard/i);
      }
      ws.serverOpen();
      ws.serverMessage('{"type":"response.created"}');
      ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
      await pending;
    });

    it("skips WebSocket for _compact bodies and keeps /compact on HTTP fallback", async () => {
      const { executor, httpExecute, calls } = newExecutorWithHttpMock();
      const seenUrls = [];
      httpExecute.mockImplementation(async (args) => {
        calls.push(structuredClone(args.body));
        executor.transformRequest(args.model, args.body, args.stream, args.credentials);
        seenUrls.push(executor.buildUrl(args.model, args.stream, 0, args.credentials));
        return { response: new Response("http") };
      });
      await executor.execute({ model: "gpt-5.3-codex", body: { input: [], _compact: true }, stream: true, credentials: {} });
      expect(FakeWebSocket.instances.length).toBe(0);
      expect(httpExecute).toHaveBeenCalledOnce();
      expect(calls[0]._compact).toBe(true);
      expect(seenUrls.some((u) => /\/compact$/.test(u))).toBe(true);
    });

    it("leaves args.body untouched for HTTP fallback when the WebSocket attempt fails", async () => {
      // A _compact body never attempts WS by design (guard above), so prove
      // clone isolation with the other non-idempotent transformRequest
      // mutations instead: without the clone they would leak into the fallback.
      const { executor, httpExecute, calls } = newExecutorWithHttpMock();
      const original = {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        temperature: 0.7,
        top_p: 0.9,
      };
      const snapshot = structuredClone(original);
      const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: original, stream: true, credentials: {} });
      ws.serverOpen();
      ws.serverError();
      await pending;
      expect(httpExecute).toHaveBeenCalledOnce();
      expect(original).toEqual(snapshot);
      expect(calls[0].body).toEqual(snapshot);
    });

    it("opens the circuit after repeated handshake failures and recovers after cooldown", async () => {
      vi.useFakeTimers();
      try {
        const { executor, httpExecute } = newExecutorWithHttpMock();
        for (let i = 0; i < 3; i++) {
          const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
          ws.serverOpen();
          ws.serverError();
          await pending;
        }
        expect(FakeWebSocket.instances.length).toBe(3);
        expect(httpExecute).toHaveBeenCalledTimes(3);
        // Circuit open: the next request skips the handshake entirely.
        await executor.execute({ model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
        expect(FakeWebSocket.instances.length).toBe(3);
        expect(httpExecute).toHaveBeenCalledTimes(4);
        // After the 5-minute cooldown the transport is attempted again.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
        expect(FakeWebSocket.instances.length).toBe(4);
        ws.serverOpen();
        ws.serverMessage('{"type":"response.created"}');
        ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
        await pending;
        expect(httpExecute).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not count first-frame error frames toward the breaker", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      for (let i = 0; i < 3; i++) {
        const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
        ws.serverOpen();
        ws.serverMessage('{"type":"error","status":429,"error":{"message":"quota exhausted"}}');
        await pending;
      }
      expect(httpExecute).toHaveBeenCalledTimes(3);
      // The server answered in-protocol three times: the transport is healthy.
      const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      expect(FakeWebSocket.instances.length).toBe(4);
      ws.serverOpen();
      ws.serverMessage('{"type":"response.created"}');
      ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
      await pending;
    });

    it("rethrows a client abort without HTTP fallback and without counting it", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      for (let i = 0; i < 3; i++) {
        const ctrl = new AbortController();
        const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {}, signal: ctrl.signal });
        ws.serverOpen();
        ctrl.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(ws.closed).toBe(true);
      }
      expect(httpExecute).not.toHaveBeenCalled();
      const { ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      expect(FakeWebSocket.instances.length).toBe(4);
      ws.serverOpen();
      ws.serverError();
    });

    it("skips the WebSocket entirely when the signal is already aborted", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(executor.execute({ model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {}, signal: ctrl.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(FakeWebSocket.instances.length).toBe(0);
      expect(httpExecute).not.toHaveBeenCalled();
    });

    it("keys the breaker by egress so a blocked direct path leaves proxied accounts on WebSocket", async () => {
      const { executor } = newExecutorWithHttpMock();
      for (let i = 0; i < 3; i++) {
        const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
        ws.serverOpen();
        ws.serverError();
        await pending;
      }
      await executor.execute({ model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      expect(FakeWebSocket.instances.length).toBe(3);
      const { pending, ws } = await executeAndWaitForWs(executor, {
        model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {},
        proxyOptions: { enabled: true, url: "http://127.0.0.1:1" },
      });
      expect(FakeWebSocket.instances.length).toBe(4);
      expect(ws.options.dispatcher).toBeDefined();
      ws.serverOpen();
      ws.serverMessage('{"type":"response.created"}');
      ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
      await pending;
    });

    it("falls back to HTTP for Vercel relay connections", async () => {
      const { executor, httpExecute } = newExecutorWithHttpMock();
      await executor.execute({
        model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {},
        proxyOptions: { vercelRelayUrl: "https://relay.example/fetch" },
      });
      expect(FakeWebSocket.instances.length).toBe(0);
      expect(httpExecute).toHaveBeenCalledOnce();
    });

    it("honours the environment proxy like the HTTP hop", async () => {
      process.env.HTTPS_PROXY = "http://127.0.0.1:1";
      const { executor } = newExecutorWithHttpMock();
      const { pending, ws } = await executeAndWaitForWs(executor, { model: "gpt-5.3-codex", body: { input: [] }, stream: true, credentials: {} });
      expect(ws.options.dispatcher).toBeDefined();
      ws.serverOpen();
      ws.serverMessage('{"type":"response.created"}');
      ws.serverMessage('{"type":"response.completed","response":{"status":"completed"}}');
      await pending;
    });
  });

  it("rejects ready at once when the signal is already aborted", async () => {
    FakeWebSocket.instances.length = 0;
    const ctrl = new AbortController();
    ctrl.abort();
    const { ready } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket, signal: ctrl.signal,
    });
    await expect(ready).rejects.toMatchObject({ name: "AbortError" });
    const ws = FakeWebSocket.instances[0];
    expect(ws.closed).toBe(true);
    ws.serverOpen();
    expect(ws.sent).toEqual([]);
  });
});
