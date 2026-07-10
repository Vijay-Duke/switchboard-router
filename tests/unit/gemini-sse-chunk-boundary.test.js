import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/lib/db/index.js", () => ({ getSettings: mocks.getSettings }));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

/**
 * Regression: transformOpenAISSEToGeminiSSE used to split each network chunk
 * independently, so any `data:` line straddling a chunk boundary was silently
 * dropped — the client lost tokens with no error.
 */
describe("v1beta streamGenerateContent SSE chunk boundaries", () => {
  it("reassembles data lines split across upstream chunks", async () => {
    const frame = (content) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
    const full = frame("Hello") + frame(" world") + "data: [DONE]\n\n";

    // Split at a byte offset that lands inside the first JSON payload.
    const cut = full.indexOf("Hello") + 2;
    const enc = new TextEncoder();
    const upstreamBody = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(full.slice(0, cut)));
        c.enqueue(enc.encode(full.slice(cut)));
        c.close();
      },
    });

    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getSettings.mockResolvedValue({});
    mocks.handleChat.mockResolvedValue(
      new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const req = new Request(
      "https://router.test/v1beta/models/gemini-pro:streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": "k" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }
    );
    const res = await POST(req, {
      params: Promise.resolve({ path: ["gemini-pro:streamGenerateContent"] }),
    });

    const out = await new Response(res.body).text();
    const texts = out
      .split("\r\n\r\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)))
      .flatMap((c) => c.candidates[0].content.parts.map((p) => p.text));

    expect(texts.join("")).toBe("Hello world");
  });
});
