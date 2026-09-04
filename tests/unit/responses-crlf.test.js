import { describe, expect, it } from "vitest";

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";

const encoder = new TextEncoder();

function byteStream(text, chunkSize = Infinity) {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
}

function event(type, payload, eol = "\n") {
  return `event: ${type}${eol}data: ${JSON.stringify({ type, ...payload })}${eol}${eol}`;
}

const MESSAGE_ITEM = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "hello" }],
};

const USAGE = { input_tokens: 3, output_tokens: 5, total_tokens: 8 };

describe("Responses SSE → JSON framing (H1/H2/H6)", () => {
  it("parses CRLF-framed events: item stored, status completed, usage kept", async () => {
    const sse = event("response.created", { response: { id: "resp_crlf", created_at: 1 } }, "\r\n")
      + event("response.output_item.done", { output_index: 0, item: MESSAGE_ITEM }, "\r\n")
      + event("response.completed", { response: { id: "resp_crlf", usage: USAGE } }, "\r\n");

    const json = await convertResponsesStreamToJson(byteStream(sse, 7));

    expect(json.id).toBe("resp_crlf");
    expect(json.status).toBe("completed");
    expect(json.output).toHaveLength(1);
    expect(json.output[0].content[0].text).toBe("hello");
    expect(json.usage).toEqual(USAGE);
  });

  it("treats response.incomplete as a terminal status and harvests its usage", async () => {
    const sse = event("response.output_item.done", { output_index: 0, item: MESSAGE_ITEM })
      + event("response.incomplete", { response: { id: "resp_trunc", status: "incomplete", usage: USAGE } });

    const json = await convertResponsesStreamToJson(byteStream(sse));

    expect(json.status).toBe("incomplete");
    expect(json.usage).toEqual(USAGE);
    expect(json.output[0].content[0].text).toBe("hello");
  });

  it("synthesizes a message from delta-only streams and never emits filler items", async () => {
    const sse = event("response.output_text.delta", { output_index: 2, delta: "hel" })
      + event("response.output_text.delta", { output_index: 2, delta: "lo" })
      + event("response.completed", { response: { id: "resp_delta", usage: USAGE } });

    const json = await convertResponsesStreamToJson(byteStream(sse));

    expect(json.output).toHaveLength(1);
    expect(json.output[0]).toMatchObject({ type: "message", role: "assistant" });
    expect(json.output[0].content[0].text).toBe("hello");
  });

  it("keeps explicit items ahead of accumulated deltas for the same index", async () => {
    const sse = event("response.output_text.delta", { output_index: 0, delta: "partial" })
      + event("response.output_item.done", { output_index: 0, item: MESSAGE_ITEM })
      + event("response.completed", { response: { id: "resp_both" } });

    const json = await convertResponsesStreamToJson(byteStream(sse));

    expect(json.output).toHaveLength(1);
    expect(json.output[0].id).toBe("msg_1");
  });
});
