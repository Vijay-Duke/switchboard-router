import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

beforeEach(() => proxyAwareFetch.mockReset());

function audioFile() {
  return new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" });
}

describe("media and search provider identity", () => {
  it("uses the STT registry profile for authenticated multipart requests", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const formData = new FormData();
    formData.append("file", audioFile());

    const result = await handleSttCore({
      provider: "openai",
      model: "whisper-1",
      formData,
      credentials: { apiKey: "stt-key" },
      sttConfig: {
        identity: "openai-node",
        format: "openai",
        baseUrl: "https://api.openai.com/v1/audio/transcriptions",
        authType: "apikey",
        authHeader: "bearer",
      },
    });

    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
        identity: "openai-node",
        provider: "openai",
        format: "openai",
      }),
    );
  });

  it("uses the TTS registry profile without OpenRouter gateway headers", async () => {
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "AAEC" } } }] })}\n\ndata: [DONE]\n\n`;
    proxyAwareFetch.mockResolvedValueOnce(new Response(chunk, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const result = await handleTtsCore({
      provider: "openrouter",
      model: "openai/gpt-4o-mini-tts/alloy",
      input: "hello",
      credentials: { apiKey: "router-key" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        identity: "openai-node",
        provider: "openrouter",
        format: "openai",
        headers: expect.not.objectContaining({
          "HTTP-Referer": expect.anything(),
          "X-Title": expect.anything(),
        }),
      }),
    );
  });

  it("uses the dedicated search registry profile", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await handleSearchCore({
      body: { query: "switchboard" },
      provider: { id: "brave-search" },
      providerConfig: {
        identity: "openai-node",
        format: "openai",
        authType: "apikey",
        authHeader: "x-subscription-token",
        baseUrl: "https://api.search.brave.com/res/v1",
        method: "GET",
      },
      credentials: { apiKey: "search-key" },
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.search.brave.com"),
      expect.objectContaining({
        identity: "openai-node",
        provider: "brave-search",
        format: "openai",
      }),
    );
  });
});
