import { describe, it, expect } from "vitest";

import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

function sseResponse(body, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("ollama transform error events (E15)", () => {
  it("surfaces SSE error events instead of a fake empty done:true", async () => {
    const res = transformToOllama(
      sseResponse(`data: ${JSON.stringify({ error: { message: "upstream boom", type: "server_error" } })}\n\n`),
      "llama3"
    );
    const text = await res.text();
    expect(text).toContain("upstream boom");
    expect(text).not.toContain('"done":true');
  });

  it("preserves a non-200 upstream status instead of coercing to 200", async () => {
    const res = transformToOllama(sseResponse("internal failure", 500), "llama3");
    expect(res.status).toBe(500);
  });

  it("keeps 200 for successful streams", async () => {
    const res = transformToOllama(
      sseResponse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'),
      "llama3"
    );
    expect(res.status).toBe(200);
  });
});
