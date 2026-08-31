import { describe, expect, it, vi } from "vitest";

import { streamResponsesOverWebSocket } from "../../open-sse/executors/codexWsTransport.js";

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

  it("emits error frames as SSE events and ends the stream", async () => {
    FakeWebSocket.instances.length = 0;
    const { response } = streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    const done = readBody(response.body);
    ws.serverMessage('{"type":"error","status":429,"error":{"message":"rate limited"}}');
    const text = await done;

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
    streamResponsesOverWebSocket({
      wsUrl: "wss://x/responses", headers: {}, request: makeRequest(), WebSocket: FakeWebSocket, signal: ctrl.signal,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ctrl.abort();

    expect(ws.closed).toBe(true);
  });
});
