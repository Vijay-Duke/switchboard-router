import { describe, expect, it } from "vitest";
import {
  appendAskToOpenAiJson,
  injectAskIntoOpenAiStream,
} from "../../open-sse/routing/feedbackInject.js";

function openAiChunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-source",
    object: "chat.completion.chunk",
    created: 1,
    model: "source",
    choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason: finishReason }],
  })}\n\n`;
}

describe("appendAskToOpenAiJson", () => {
  it("appends an ask to string assistant content", async () => {
    const response = new Response(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
      { headers: { "content-type": "application/json" } }
    );

    const out = await appendAskToOpenAiJson(response, "\n\nASK");
    expect((await out.json()).choices[0].message.content).toBe("hello\n\nASK");
  });

  it("returns the original response for malformed JSON", async () => {
    const response = new Response("not json");
    const out = await appendAskToOpenAiJson(response, "\n\nASK");
    expect(out).toBe(response);
    expect(await out.text()).toBe("not json");
  });

  it("returns the original response when content is not a string", async () => {
    const response = new Response(
      JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "hello" }] } }] })
    );
    const out = await appendAskToOpenAiJson(response, "\n\nASK");
    expect(out).toBe(response);
    expect(await out.text()).toBe(
      JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "hello" }] } }] })
    );
  });
});

describe("injectAskIntoOpenAiStream", () => {
  it("preserves source chunks and injects the ask before the finish chunk", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(openAiChunk("hi")));
        controller.enqueue(encoder.encode(openAiChunk(" there")));
        controller.enqueue(encoder.encode(openAiChunk(null, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });

    const out = injectAskIntoOpenAiStream(response, "\n\nASKLINE");
    const text = await out.text();
    const chunks = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const askIndex = chunks.findIndex((chunk) => chunk.choices?.[0]?.delta?.content === "\n\nASKLINE");
    const finishIndex = chunks.findIndex((chunk) => chunk.choices?.[0]?.finish_reason === "stop");

    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"content":" there"');
    expect(askIndex).toBeGreaterThan(-1);
    expect(finishIndex).toBeGreaterThan(-1);
    expect(askIndex).toBeLessThan(finishIndex);
    expect((text.match(/\[DONE\]/g) || [])).toHaveLength(1);
  });

  it("uses the on-done fallback when the provider omits a finish chunk", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(openAiChunk("hi")));
        controller.enqueue(encoder.encode(openAiChunk(" there")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const out = injectAskIntoOpenAiStream(new Response(stream), "\n\nASKLINE");
    const text = await out.text();
    const askIndex = text.indexOf("ASKLINE");
    const doneIndex = text.indexOf("[DONE]");

    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"content":" there"');
    expect(askIndex).toBeGreaterThan(-1);
    expect(askIndex).toBeLessThan(doneIndex);
    expect((text.match(/\[DONE\]/g) || [])).toHaveLength(1);
  });
});
