import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Codex closes the socket on response.completed (the Responses API has no
// [DONE]), cancelling the reader before flush(). Usage accounting must run on
// the terminal event itself. (ported from upstream d7f7d70d)
const enc = new TextEncoder();
const completed = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "r1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
})}\n\n`;
const delta = `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`;

async function writeThenCancel(stream) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  writer.write(enc.encode(delta)).catch(() => {});
  writer.write(enc.encode(completed)).catch(() => {});
  let out = "";
  const dec = new TextDecoder();
  while (!out.includes("response.completed")) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  await reader.cancel();
  return out;
}

describe("Responses terminal-event finalization", () => {
  it("passthrough: fires onStreamComplete once before flush when client closes on response.completed", async () => {
    const calls = [];
    const stream = createPassthroughStreamWithLogger("codex", null, null, "gpt-5", null, {}, (r, usage) => calls.push(usage));
    await writeThenCancel(stream);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeTruthy();
  });

  it("translate (responses→responses): fires onStreamComplete once on the terminal event", async () => {
    const calls = [];
    const stream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, null, "gpt-5", null, {},
      (r, usage) => calls.push(usage), null, false
    );
    await writeThenCancel(stream);
    expect(calls).toHaveLength(1);
  });

  it("passthrough: a normal flush after the terminal event does not double-finalize", async () => {
    const calls = [];
    const stream = createPassthroughStreamWithLogger("codex", null, null, "gpt-5", null, {}, (r, usage) => calls.push(usage));
    const writer = stream.writable.getWriter();
    const drain = new Response(stream.readable).text();
    await writer.write(enc.encode(delta));
    await writer.write(enc.encode(completed));
    await writer.close();
    await drain;
    expect(calls).toHaveLength(1);
  });
});
