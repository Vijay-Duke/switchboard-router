import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function run(provider, text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return readAll(stream.pipeThrough(createPassthroughStreamWithLogger(provider, null, null, "m", "conn", {}, null, null)));
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

function event(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("passthrough terminal synthesis (H11)", () => {
  it.each(["gemini-cli", "gemini", "vertex", "antigravity", "vertex-partner", "claude-vertex"])(
    "never appends [DONE] for Gemini-family provider %s", async (provider) => {
      const out = await run(provider, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n");
      expect(out).not.toContain("[DONE]");
    },
  );

  it("still terminates OpenAI-style passthrough with [DONE]", async () => {
    const out = await run("openrouter", "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n");
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("synthesizes response.failed when a Responses-framed passthrough is truncated", async () => {
    const out = await run("codex",
      event("response.created", { response: { id: "resp_1", status: "in_progress" } })
      + event("response.output_text.delta", { delta: "partial" }));

    expect(out).toContain("event: response.failed");
    expect(out.indexOf("event: response.failed")).toBeGreaterThan(out.indexOf("partial"));
  });

  it("does not synthesize response.failed after a real terminal event", async () => {
    const out = await run("codex",
      event("response.created", { response: { id: "resp_1", status: "in_progress" } })
      + event("response.completed", { response: { id: "resp_1", status: "completed" } }));

    expect(out).not.toContain("event: response.failed");
  });
});
