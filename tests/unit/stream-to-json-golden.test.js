import { describe, it, expect } from "vitest";
import {
  parseChatCompletionsSSEToJson,
  convertChatCompletionsStreamToJson,
  convertResponsesStreamToJson,
} from "../../open-sse/transformer/streamToJsonConverter.js";

/**
 * Credential-free golden for the forced-stream → JSON path (review M5 / L1).
 * No provider, no network, no DB — so the regression gate can protect the
 * streaming translator on a plain checkout.
 */

const enc = new TextEncoder();

/** Build a ReadableStream of Uint8Array chunks from strings. */
function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const GOLDEN_CHAT_SSE = [
  sse({ id: "chatcmpl-golden", created: 1, model: "acme/model-1", choices: [{ index: 0, delta: { role: "assistant" } }] }),
  sse({ choices: [{ index: 0, delta: { reasoning_content: "think " } }] }),
  sse({ choices: [{ index: 0, delta: { reasoning_content: "harder" } }] }),
  sse({ choices: [{ index: 0, delta: { content: "Hello" } }] }),
  sse({ choices: [{ index: 0, delta: { content: ", world" } }] }),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sse({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
  "data: [DONE]\n\n",
].join("");

const GOLDEN_TOOL_SSE = [
  sse({ id: "chatcmpl-tool", created: 2, model: "acme/model-1", choices: [{ index: 0, delta: { role: "assistant" } }] }),
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_", arguments: '{"ci' } }] } }] }),
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: 'ty":"NYC"}' } }] } }] }),
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "clock", arguments: "{}" } }] } }] }),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  "data: [DONE]\n\n",
].join("");

describe("GOLDEN: chat-completions SSE → JSON", () => {
  it("assembles content, reasoning, finish_reason and usage", () => {
    expect(parseChatCompletionsSSEToJson(GOLDEN_CHAT_SSE, "fallback/model")).toMatchInlineSnapshot(`
      {
        "choices": [
          {
            "finish_reason": "stop",
            "index": 0,
            "message": {
              "content": "Hello, world",
              "reasoning_content": "think harder",
              "role": "assistant",
            },
          },
        ],
        "created": 1,
        "id": "chatcmpl-golden",
        "model": "acme/model-1",
        "object": "chat.completion",
        "usage": {
          "completion_tokens": 3,
          "prompt_tokens": 7,
          "total_tokens": 10,
        },
      }
    `);
  });

  it("concatenates split tool-call names/arguments and orders by index", () => {
    const out = parseChatCompletionsSSEToJson(GOLDEN_TOOL_SSE, "fallback/model");

    expect(out.choices[0].finish_reason).toBe("tool_calls");
    // Content is null (not "") when the turn is purely tool calls.
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } },
      { id: "call_2", type: "function", function: { name: "clock", arguments: "{}" } },
    ]);
  });

  it("falls back to the caller's model when the stream never names one", () => {
    const out = parseChatCompletionsSSEToJson(sse({ choices: [{ delta: { content: "hi" } }] }), "fallback/model");
    expect(out.model).toBe("fallback/model");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  it("ignores malformed data lines instead of throwing", () => {
    const raw = "data: {not json}\n\n" + sse({ choices: [{ delta: { content: "ok" } }] });
    expect(parseChatCompletionsSSEToJson(raw, "m").choices[0].message.content).toBe("ok");
  });

  it("returns null when the stream carried no chunks at all", () => {
    expect(parseChatCompletionsSSEToJson("data: [DONE]\n\n", "m")).toBeNull();
    expect(parseChatCompletionsSSEToJson("", "m")).toBeNull();
  });

  it("refuses a body over the byte cap rather than buffering it (M5)", () => {
    expect(() => parseChatCompletionsSSEToJson(GOLDEN_CHAT_SSE, "m", { maxBytes: 16 })).toThrow(
      /STREAM_TO_JSON_MAX_BYTES/
    );
  });
});

describe("GOLDEN: chat-completions ReadableStream → JSON", () => {
  it("produces the same result as parsing the raw text", async () => {
    const fromStream = await convertChatCompletionsStreamToJson(streamOf(GOLDEN_CHAT_SSE), "fallback/model");
    expect(fromStream).toEqual(parseChatCompletionsSSEToJson(GOLDEN_CHAT_SSE, "fallback/model"));
  });

  it("reassembles an SSE event split across chunk boundaries", async () => {
    const mid = Math.floor(GOLDEN_CHAT_SSE.length / 2);
    const fromSplit = await convertChatCompletionsStreamToJson(
      streamOf(GOLDEN_CHAT_SSE.slice(0, mid), GOLDEN_CHAT_SSE.slice(mid)),
      "fallback/model"
    );
    expect(fromSplit).toEqual(parseChatCompletionsSSEToJson(GOLDEN_CHAT_SSE, "fallback/model"));
  });

  it("returns null for a non-stream input", async () => {
    expect(await convertChatCompletionsStreamToJson(null, "m")).toBeNull();
    expect(await convertChatCompletionsStreamToJson({}, "m")).toBeNull();
  });

  it("aborts a stream that exceeds the byte cap (M5)", async () => {
    await expect(
      convertChatCompletionsStreamToJson(streamOf(GOLDEN_CHAT_SSE), "m", { maxBytes: 16 })
    ).rejects.toThrow(/STREAM_TO_JSON_MAX_BYTES/);
  });
});

describe("GOLDEN: responses-API stream → JSON", () => {
  const RESPONSES_SSE = [
    `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_golden", created_at: 11 } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
    })}\n\n`,
  ].join("");

  it("accumulates completed output items and usage", async () => {
    const out = await convertResponsesStreamToJson(streamOf(RESPONSES_SSE));

    expect(out).toMatchObject({
      id: "resp_golden",
      status: "completed",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });
    expect(JSON.stringify(out)).toContain("Hello");
  });

  it("keeps output items in index order even when they complete out of order", async () => {
    const item = (i, text) =>
      `event: response.output_item.done\ndata: ${JSON.stringify({
        output_index: i,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })}\n\n`;
    const out = await convertResponsesStreamToJson(
      streamOf(item(1, "second") + item(0, "first") + `event: response.completed\ndata: {}\n\n`)
    );
    const rendered = JSON.stringify(out);
    expect(rendered.indexOf("first")).toBeLessThan(rendered.indexOf("second"));
  });

  it("marks a failed response as failed", async () => {
    const out = await convertResponsesStreamToJson(
      streamOf(`event: response.failed\ndata: ${JSON.stringify({})}\n\n`)
    );
    expect(out.status).toBe("failed");
  });

  it("aborts a responses stream that exceeds the byte cap (M5)", async () => {
    await expect(convertResponsesStreamToJson(streamOf(RESPONSES_SSE), { maxBytes: 8 })).rejects.toThrow(
      /STREAM_TO_JSON_MAX_BYTES/
    );
  });
});
