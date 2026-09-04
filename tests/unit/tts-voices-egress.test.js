// @ts-check
// T125: the shared TTS voices aggregate prefers the x-api-key header over the
// URL-logged apiKey query param (query stays as fallback).
// T126: deepgram/inworld voice catalog egress goes through proxyAwareFetch so
// proxy-required environments behave like the MCP registry route.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: vi.fn(),
}));

const proxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyFetchMock }));

const voiceFetcher = vi.hoisted(() => vi.fn());
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  VOICE_FETCHERS: { elevenlabs: voiceFetcher },
}));

import { GET as voicesGET } from "../../src/app/api/media-providers/tts/voices/route.js";
import { GET as deepgramGET } from "../../src/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as inworldGET } from "../../src/app/api/media-providers/tts/inworld/voices/route.js";
import { getProviderConnections } from "@/lib/db/index.js";

beforeEach(() => {
  vi.clearAllMocks();
  voiceFetcher.mockResolvedValue([]);
});

describe("tts/voices aggregate key transport (T125)", () => {
  it("passes the x-api-key header value to the elevenlabs fetcher", async () => {
    voiceFetcher.mockResolvedValue([{ voiceId: "v1", name: "V1", language: "en" }]);
    const res = await voicesGET(new Request("http://l/api/media-providers/tts/voices?provider=elevenlabs", {
      headers: { "x-api-key": "header-key" },
    }));
    expect(res.status).toBe(200);
    expect(voiceFetcher).toHaveBeenCalledWith("header-key");
  });

  it("still accepts apiKey as a query fallback", async () => {
    voiceFetcher.mockResolvedValue([]);
    const res = await voicesGET(new Request("http://l/api/media-providers/tts/voices?provider=elevenlabs&apiKey=query-key"));
    expect(res.status).toBe(200);
    expect(voiceFetcher).toHaveBeenCalledWith("query-key");
  });
});

describe("voice catalog egress via proxyAwareFetch (T126)", () => {
  it("deepgram fetches /v1/models through the proxy helper", async () => {
    getProviderConnections.mockResolvedValueOnce([{ apiKey: "dg-key" }]);
    proxyFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ tts: [{ name: "Thalia", canonical_name: "aura-2-thalia-en", languages: ["en"] }] }),
    });

    const res = await deepgramGET(new Request("http://l/api/media-providers/tts/deepgram/voices"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.deepgram.com/v1/models");
    expect(proxyFetchMock.mock.calls[0][1].headers.Authorization).toBe("Token dg-key");
    expect(body.byLang.en.voices[0].id).toBe("aura-2-thalia-en");
  });

  it("inworld fetches the voice list through the proxy helper", async () => {
    getProviderConnections.mockResolvedValueOnce([{ apiKey: "iw-key" }]);
    proxyFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ voices: [{ voiceId: "inw1", displayName: "Inw One", gender: "MALE", languages: ["en"] }] }),
    });

    const res = await inworldGET(new Request("http://l/api/media-providers/tts/inworld/voices"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.inworld.ai/tts/v1/voices");
    expect(proxyFetchMock.mock.calls[0][1].headers.Authorization).toBe("Basic iw-key");
    expect(body.byLang.en.voices[0].id).toBe("inw1");
  });
});
