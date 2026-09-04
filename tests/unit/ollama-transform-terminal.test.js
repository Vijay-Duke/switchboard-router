import { describe, it, expect } from "vitest";

import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const MODEL = "llama3";

function sseResponse(lines, { status = 200, splitAt = null } = {}) {
  const text = lines.join("");
  const bytes = new TextEncoder().encode(text);
  const parts = splitAt === null ? [bytes] : [bytes.slice(0, splitAt), bytes.slice(splitAt)];
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

async function readText(response) {
  return response.text();
}

function countDoneTrue(text) {
  return text.split("\n").filter((l) => l.includes('"done":true')).length;
}

const stopChunk = (extra = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", ...extra }] })}\n\n`;
const toolChunk = () =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`;
const contentChunk = (content) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;

describe("ollama transform single terminal (E13)", () => {
  it("emits exactly one done:true for stop + [DONE] + flush", async () => {
    const res = transformToOllama(
      sseResponse([contentChunk("hi"), stopChunk(), "data: [DONE]\n\n"]),
      MODEL
    );
    expect(countDoneTrue(await readText(res))).toBe(1);
  });

  it("emits exactly one done:true for tool_calls finish", async () => {
    const res = transformToOllama(sseResponse([toolChunk(), "data: [DONE]\n\n"]), MODEL);
    expect(countDoneTrue(await readText(res))).toBe(1);
  });

  it("emits exactly one done:true for a bare [DONE] stream", async () => {
    const res = transformToOllama(sseResponse(["data: [DONE]\n\n"]), MODEL);
    expect(countDoneTrue(await readText(res))).toBe(1);
  });

  it("still streams content with done:false before the terminal", async () => {
    const res = transformToOllama(sseResponse([contentChunk("hello"), stopChunk()]), MODEL);
    const text = await readText(res);
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"done":false');
    expect(countDoneTrue(text)).toBe(1);
  });
});

describe("ollama transform split multibyte chars (E14)", () => {
  it("does not mojibake an emoji split across chunks", async () => {
    const line = contentChunk("hi 😀 bye");
    const bytes = new TextEncoder().encode(line);
    // Split inside the 4-byte emoji sequence (find its offset first).
    const emojiOffset = line.indexOf("😀");
    const byteOffset = new TextEncoder().encode(line.slice(0, emojiOffset)).length;
    const res = transformToOllama(
      sseResponse([line], { splitAt: byteOffset + 1 }),
      MODEL
    );
    const text = await readText(res);
    expect(bytes.length).toBeGreaterThan(byteOffset + 1);
    expect(text).toContain("😀");
    expect(text).not.toContain("�");
  });
});
