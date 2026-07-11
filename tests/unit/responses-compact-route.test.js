import { beforeEach, describe, expect, it, vi } from "vitest";

const handleChat = vi.fn();
const initTranslators = vi.fn();

vi.mock("../../src/sse/handlers/chat.js", () => ({ handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators }));

const { POST } = await import("../../src/app/api/v1/responses/compact/route.js");

describe("POST /v1/responses/compact", () => {
  beforeEach(() => {
    handleChat.mockReset();
    initTranslators.mockReset();
    handleChat.mockResolvedValue(new Response("ok"));
  });

  it("returns 400 instead of throwing for malformed JSON", async () => {
    const response = await POST(new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Invalid JSON body" } });
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("preserves the incoming abort signal on the synthetic request", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-4o" }),
      signal: controller.signal,
    });

    await POST(request);
    controller.abort();

    expect(handleChat).toHaveBeenCalledOnce();
    expect(handleChat.mock.calls[0][0].signal.aborted).toBe(true);
  });
});
