// H41/H42 — codex image SSE: terminal [DONE] sentinel, CRLF framing, multi-line data.
import { describe, it, expect, vi } from "vitest";
import codexImage from "../../open-sse/handlers/imageProviders/codex.js";

const sse = (text) => new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
const DONE_ITEM = JSON.stringify({ item: { type: "image_generation_call", result: "QUJD" } });

describe("codex image SSE", () => {
  it("streamed generation ends with data: [DONE]", async () => {
    const onSuccess = vi.fn();
    const { sseResponse } = await codexImage.parseResponse(
      sse(`event: response.output_item.done\ndata: ${DONE_ITEM}\n\n`),
      { log: null, streamToClient: true, onRequestSuccess: onSuccess },
    );
    const out = await sseResponse.text();
    expect(out).toContain("event: done");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("still terminates with [DONE] after an error event (no image)", async () => {
    const { sseResponse } = await codexImage.parseResponse(
      sse("event: response.completed\ndata: {}\n\n"),
      { log: null, streamToClient: true },
    );
    const out = await sseResponse.text();
    expect(out).toContain("event: error");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("recovers the image from a CRLF-framed stream", async () => {
    const parsed = await codexImage.parseResponse(
      sse(`event: response.output_item.done\r\ndata: ${DONE_ITEM}\r\n\r\n`),
      { log: null, streamToClient: false },
    );
    expect(parsed.data[0].b64_json).toBe("QUJD");
  });

  it("joins multi-line data blocks", async () => {
    const parsed = await codexImage.parseResponse(
      sse('event: response.output_item.done\ndata: {"item":{"type":"image_generation_call",\ndata: "result":"QUJD"}}\n\n'),
      { log: null, streamToClient: false },
    );
    expect(parsed.data[0].b64_json).toBe("QUJD");
  });
});
