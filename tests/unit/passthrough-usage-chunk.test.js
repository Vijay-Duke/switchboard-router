import { describe, expect, it, vi } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function source(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("passthrough usage harvesting (H10)", () => {
  it("records a usage-only delta:{} frame instead of estimating", async () => {
    const onStreamComplete = vi.fn(async () => {});
    const sse = chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })
      + chunk({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } })
      + "data: [DONE]\n\n";

    const out = await readAll(source(sse).pipeThrough(
      createPassthroughStreamWithLogger("openrouter", null, null, "m", "conn", { messages: [] }, onStreamComplete, null),
    ));

    expect(out).toContain("\"usage\"");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    const usage = onStreamComplete.mock.calls[0][1];
    expect(usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 7 });
  });
});

describe("passthrough degraded upstream (H12)", () => {
  it("fails the stream after consecutive non-JSON data events instead of hanging", async () => {
    const sse = chunk({ choices: [{ index: 0, delta: { content: "ok" } }] })
      + "data: <html>rate limited</html>\n\n".repeat(5);

    await expect(readAll(source(sse).pipeThrough(
      createPassthroughStreamWithLogger("openrouter", null, null, "m", "conn", { messages: [] }, null, null),
    ))).rejects.toThrow(/consecutive non-JSON/);
  });

  it("tolerates a lone non-JSON data event between valid frames", async () => {
    const sse = chunk({ choices: [{ index: 0, delta: { content: "a" } }] })
      + "data: noise\n\n"
      + chunk({ choices: [{ index: 0, delta: { content: "b" }, finish_reason: "stop" }] })
      + "data: [DONE]\n\n";

    const out = await readAll(source(sse).pipeThrough(
      createPassthroughStreamWithLogger("openrouter", null, null, "m", "conn", { messages: [] }, null, null),
    ));
    expect(out).toContain("\"content\":\"b\"");
    expect(out).toContain("data: [DONE]");
  });
});

describe("translate-path multi-line data events (H13)", () => {
  function translate(sse) {
    return readAll(source(sse).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "openrouter", null, null, "m", "conn", { messages: [] }, null, null),
    ));
  }

  it("reassembles a spec-legal multi-line data payload into one event", async () => {
    const out = await translate("data: {\"choices\":[{\"index\":0,\ndata: \"delta\":{\"content\":\"joined\"}}]}\n\ndata: [DONE]\n\n");
    expect(out).toContain("\"content\":\"joined\"");
  });

  it("still parses self-contained data lines that share one blank-line frame", async () => {
    const a = JSON.stringify({ choices: [{ index: 0, delta: { content: "a" } }] });
    const b = JSON.stringify({ choices: [{ index: 0, delta: { content: "b" } }] });
    const out = await translate(`data: ${a}\ndata: ${b}\n\ndata: [DONE]\n\n`);
    expect(out).toContain("\"content\":\"a\"");
    expect(out).toContain("\"content\":\"b\"");
  });

  it("keeps per-line parsing for NDJSON-style upstreams with no blank-line framing", async () => {
    const a = JSON.stringify({ choices: [{ index: 0, delta: { content: "n1" } }] });
    const b = JSON.stringify({ choices: [{ index: 0, delta: { content: "n2" } }] });
    const out = await translate(`data: ${a}\ndata: ${b}\ndata: [DONE]\n`);
    expect(out).toContain("\"content\":\"n1\"");
    expect(out).toContain("\"content\":\"n2\"");
  });
});
