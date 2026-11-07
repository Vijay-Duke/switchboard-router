// response.completed must carry the streamed output items (#4307) and the real
// usage even when the usage trailer follows finish_reason (#3432), bounded by a
// watchdog. (ported from upstream 273f0c32, 7111db35, fbcaa282)
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
const text = chunk({ id: "c1", choices: [{ index: 0, delta: { content: "hello" } }] });
const finish = chunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const usage = chunk({ id: "c1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });

function completedFrom(out) {
  const frame = out.split("\n\n").find(f => f.startsWith("event: response.completed"));
  return frame ? JSON.parse(frame.split("\n").find(l => l.startsWith("data: ")).slice(6)).response : null;
}

async function run(frames, { close = true } = {}) {
  const stream = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai", null, null, "gpt-5", null, {}, null, null, false);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const dec = new TextDecoder();
  let out = "";
  const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value); } })();
  for (const f of frames) await writer.write(enc.encode(f));
  if (close) { await writer.close(); await pump; }
  return { get out() { return out; }, writer, pump };
}

afterEach(() => vi.useRealTimers());

describe("chat→Responses response.completed", () => {
  it("repeats streamed items in response.output", async () => {
    const { out } = await run([text, finish, usage]);
    expect(completedFrom(out).output).toEqual([expect.objectContaining({ type: "message", content: [expect.objectContaining({ text: "hello" })] })]);
  });

  it("waits for the usage trailer that follows finish_reason", async () => {
    const { out } = await run([text, finish, usage]);
    expect(completedFrom(out).usage).toMatchObject({ input_tokens: 11, output_tokens: 3 });
    expect(out.match(/event: response\.completed/g)).toHaveLength(1);
  });

  it("flushes on [DONE] even if the upstream keeps the connection open", async () => {
    const h = await run([text, finish, "data: [DONE]\n\n"], { close: false });
    await new Promise(r => setTimeout(r, 10));
    expect(completedFrom(h.out)).not.toBeNull();
    await h.writer.close(); await h.pump;
  });

  it("bounds the wait with a watchdog when the upstream stalls after finish_reason", async () => {
    vi.useFakeTimers();
    const h = await run([text, finish], { close: false });
    expect(completedFrom(h.out)).toBeNull();
    await vi.advanceTimersByTimeAsync(3100);
    expect(completedFrom(h.out)).not.toBeNull();
    vi.useRealTimers();
    await h.writer.close(); await h.pump;
  });
});
