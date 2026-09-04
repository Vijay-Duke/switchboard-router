import { describe, expect, it } from "vitest";

import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function run(chunks) {
  const transform = createResponsesApiTransformStream();
  const writer = transform.writable.getWriter();
  const readAll = (async () => {
    const reader = transform.readable.getReader();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  })();
  for (const chunk of chunks) await writer.write(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  await writer.close();
  return readAll;
}

function chatChunk(delta, finish = null, eol = "\n") {
  const body = { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(body)}${eol}${eol}`;
}

describe("Chat Completions → Responses transformer framing (H7/H8/H9)", () => {
  it("splits CRLF-framed events and joins multi-line data payloads", async () => {
    const multiLine = "data: {\"choices\":[{\"index\":0,\ndata: \"delta\":{\"content\":\"lo\"}}]}\n\n";
    const out = await run([chatChunk({ role: "assistant", content: "hel" }, null, "\r\n"), multiLine, chatChunk({}, "stop")]);

    expect(out).toContain("\"delta\":\"hel\"");
    expect(out).toContain("\"delta\":\"lo\"");
    expect(out).toContain("event: response.completed");
    expect(out).not.toContain("event: response.incomplete");
  });

  it("keeps a multibyte character that straddles two chunks intact", async () => {
    const bytes = encoder.encode(chatChunk({ content: "a😀b" }));
    const emojiStart = bytes.indexOf(0xf0);
    const out = await run([bytes.slice(0, emojiStart + 2), bytes.slice(emojiStart + 2), chatChunk({}, "stop")]);

    expect(out).toContain("a😀b");
    expect(out).not.toContain("�");
  });

  it("parses the unframed tail on flush and reports a turn without finish_reason as incomplete", async () => {
    const tailOnly = chatChunk({ content: "tail" }).slice(0, -2); // no trailing blank line
    const out = await run([tailOnly]);

    expect(out).toContain("\"delta\":\"tail\"");
    expect(out).toContain("event: response.incomplete");
    expect(out).not.toContain("event: response.completed");
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
