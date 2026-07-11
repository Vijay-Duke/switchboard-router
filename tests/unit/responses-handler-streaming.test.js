import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { handleResponsesCore } from "../../open-sse/handlers/responsesHandler.js";

describe("Responses API streaming wrapper", () => {
  it("preserves a Responses SSE body already produced by chat core", async () => {
    const body = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n',
      '\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join("");
    handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    });

    const result = await handleResponsesCore({
      body: { model: "test", input: "hi", stream: true },
      modelInfo: { provider: "test", model: "test" },
      credentials: {},
    });

    expect(result.success).toBe(true);
    await expect(result.response.text()).resolves.toContain("hello");
  });
});
