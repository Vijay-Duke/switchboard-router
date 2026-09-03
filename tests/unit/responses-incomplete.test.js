import { describe, expect, it } from "vitest";

import { streamResponsesOverWebSocket } from "../../open-sse/executors/codexWsTransport.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseEvent(type, payload) {
  return [`event: ${type}`, `data: ${JSON.stringify(payload)}`, ""].join("\n");
}

// Responses -> Chat Completions direction: upstream provider speaks Responses,
// downstream client speaks OpenAI chat.
function runChatTransform(input, ...extraArgs) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "codex",
      null,
      null,
      "gpt-5.6-sol",
      ...extraArgs,
    ),
  );

  return readAll(output);
}

// Same-format Responses passthrough (Codex CLI / Droid direction).
function runPassthrough(input) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "codex",
      null,
      null,
      "gpt-5.6-sol",
    ),
  );

  return readAll(output);
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function incompleteEvent(reason, usage) {
  return sseEvent("response.incomplete", {
    type: "response.incomplete",
    response: {
      id: "resp_truncated",
      status: "incomplete",
      incomplete_details: { reason },
      ...(usage ? { usage } : {}),
    },
  });
}

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
  serverOpen() { this.onopen?.(); }
  serverMessage(text) { this.onmessage?.({ data: text }); }
  serverClose() { this.onclose?.(); }
}
FakeWebSocket.instances = [];

describe("response.incomplete terminal handling", () => {
  it("maps max_output_tokens to finish_reason length followed by [DONE]", async () => {
    const output = await runChatTransform(
      [
        sseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          delta: "partial answer",
        }),
        incompleteEvent("max_output_tokens", {
          input_tokens: 100,
          output_tokens: 50,
        }),
      ].join("\n"),
    );

    expect(output).toContain('"finish_reason":"length"');
    expect(output).toContain("data: [DONE]");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("maps content_filter to finish_reason content_filter", async () => {
    const output = await runChatTransform(incompleteEvent("content_filter"));

    expect(output).toContain('"finish_reason":"content_filter"');
    expect(output).toContain("data: [DONE]");
  });

  it("finalizes as tool_calls when a tool call is pending", async () => {
    const output = await runChatTransform(
      [
        sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "fc_call_1",
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: "",
          },
        }),
        incompleteEvent("max_output_tokens"),
      ].join("\n"),
    );

    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).toContain("data: [DONE]");
  });

  it("passthrough does not append synthetic response.failed after response.incomplete", async () => {
    const output = await runPassthrough(
      [
        sseEvent("response.created", {
          type: "response.created",
          response: { id: "resp_truncated", status: "in_progress" },
        }),
        incompleteEvent("max_output_tokens"),
      ].join("\n"),
    );

    expect(output).toContain("event: response.incomplete");
    expect(output).not.toContain("event: response.failed");
    expect(output).toContain("data: [DONE]");
  });

  it("emits [DONE] for an incomplete event with terminateOnResponsesTerminal=false", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(incompleteEvent("max_output_tokens")));
        controller.close();
      },
    });

    const output = stream.pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI,
        "codex",
        null,
        null,
        "gpt-5.6-sol",
        null,
        null,
        null,
        null,
        false,
      ),
    );

    const text = await readAll(output);
    expect(text).toContain("data: [DONE]");
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("closes the WS socket cleanly on response.incomplete", async () => {
    FakeWebSocket.instances.length = 0;
    const { response } = streamResponsesOverWebSocket({
      wsUrl: "wss://chatgpt.com/backend-api/codex/responses",
      headers: {},
      request: { model: "gpt-5.6-sol", input: [], stream: true },
      WebSocket: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();

    const done = readAll(response.body);
    ws.serverMessage(
      '{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
    );
    const text = await done;

    expect(text).toContain("event: response.incomplete");
    expect(ws.closed).toBe(true);
  });
});
