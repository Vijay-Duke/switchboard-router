import { describe, expect, it, vi } from "vitest";

import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

describe("fetch and TTS input/error hardening", () => {
  it("returns a gateway error when the fetch handler logger is an object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("socket terminated")); },
    }), { status: 200 })));
    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "jina-reader",
      credentials: { apiKey: "key" },
      log: { error: vi.fn() },
    });
    expect(result).toMatchObject({ success: false, status: 502 });
    vi.unstubAllGlobals();
  });

  it("returns 400 instead of trimming a non-string TTS input", async () => {
    const result = await handleTtsCore({ provider: "edge-tts", model: "voice", input: {} });
    expect(result).toMatchObject({ success: false, status: 400 });
  });
});
