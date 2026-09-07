import { describe, expect, it } from "vitest";

import {
  buildAbortedChatCompletionsTerminalBytes,
  buildAbortedResponsesTerminalBytes,
} from "../../open-sse/utils/responsesStreamHelpers.js";
import { createDisconnectAwareStream, createStreamController } from "../../open-sse/utils/streamHandler.js";

function parseSSE(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const dataLines = frame.split("\n").filter((l) => l.startsWith("data: "));
    return dataLines.map((l) => l.slice(6));
  }).flat();
}

describe("abort terminal bytes", () => {
  it("chat-completions terminal emits finish_reason:stream_stalled chunk + [DONE]", () => {
    const text = new TextDecoder().decode(buildAbortedChatCompletionsTerminalBytes());
    const events = parseSSE(text);
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("[DONE]");

    const chunk = JSON.parse(events[0]);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].finish_reason).toBe("stream_stalled");
    expect(chunk.error.code).toBe("stream_stalled");
  });

  it("responses terminal emits response.failed + [DONE]", () => {
    const text = new TextDecoder().decode(buildAbortedResponsesTerminalBytes());
    const events = parseSSE(text);
    expect(events[1]).toBe("[DONE]");
    const parsed = JSON.parse(events[0]);
    expect(parsed.type).toBe("response.failed");
    expect(parsed.response.status).toBe("failed");
  });
});

describe("aborting an openai-wire stream surfaces the terminal to the client", () => {
  it("stall abort closes the client stream with the stall terminal instead of silent EOF", async () => {
    const encoder = new TextEncoder();
    const controller = createStreamController({ provider: "glm", model: "glm-5.3" });

    const upstream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(`data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`));
        // never more bytes and never closes — simulates the stalled upstream.
        // Mirror undici: aborting the fetch signal errors the body stream.
        controller.signal.addEventListener("abort", () => {
          c.error(new DOMException("aborted", "AbortError"));
        });
      },
    });

    const transformed = upstream.pipeThrough(new TransformStream());

    const clientStream = createDisconnectAwareStream(
      { readable: transformed, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      controller,
      buildAbortedChatCompletionsTerminalBytes,
    );

    // Simulate the stall timeout: handleError + abort, exactly what pipeWithDisconnect does
    controller.handleError(new Error("stream stall timeout"));
    controller.abort();

    const reader = clientStream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    const events = parseSSE(text);
    const terminal = JSON.parse(events[events.length - 2]);
    expect(terminal.choices[0].finish_reason).toBe("stream_stalled");
    expect(events[events.length - 1]).toBe("[DONE]");
  });
});
