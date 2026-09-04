import { describe, it, expect } from "vitest";

import { KiroExecutor } from "../../open-sse/executors/kiro.js";

// Build one AWS EventStream frame. CRCs are ignored by parseEventFrame.
function eventFrame(headers, payloadObj) {
  const headerBytes = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = new TextEncoder().encode(name);
    const v = new TextEncoder().encode(value);
    headerBytes.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj));
  const headersLength = headerBytes.length;
  const totalLength = 12 + headersLength + payload.length + 4;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headersLength, false);
  out.set(headerBytes, 12);
  out.set(payload, 12 + headersLength);
  return out;
}

function sseResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
}

async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("kiro exception frames (E5)", () => {
  it("surfaces a mid-stream ThrottlingException as an error chunk, not clean stop", async () => {
    const ex = new KiroExecutor();
    const frames = [
      eventFrame(
        { ":event-type": "assistantResponseEvent", ":message-type": "event" },
        { content: "partial answer" }
      ),
      eventFrame(
        { ":exception-type": "ThrottlingException", ":message-type": "exception" },
        { message: "Rate exceeded for this account" }
      ),
    ];
    const out = ex.transformEventStreamToSSE(sseResponse(frames), "kiro/model");
    const text = await readAll(out);
    expect(text).toContain("Rate exceeded for this account");
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  it("handles :message-type=exception without :exception-type", async () => {
    const ex = new KiroExecutor();
    const frames = [
      eventFrame({ ":message-type": "exception" }, { message: "Quota hit" }),
    ];
    const out = ex.transformEventStreamToSSE(sseResponse(frames), "kiro/model");
    const text = await readAll(out);
    expect(text).toContain("Quota hit");
    expect(text).not.toContain('"finish_reason":"stop"');
  });
});
