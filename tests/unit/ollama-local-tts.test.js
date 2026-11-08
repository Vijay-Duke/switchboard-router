import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetch,
  proxyOptionsFromCredentials: () => null,
  resolveProxyUrl: () => null,
  getDispatcher: async () => null,
}));

import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { buildTtsProviderModels, getTtsVoicesForModel } from "../../open-sse/config/ttsModels.js";
import { AI_PROVIDERS, getProvidersByKind } from "../../src/shared/constants/providers.js";
import { getTtsAdapter } from "../../open-sse/handlers/ttsProviders/index.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { TTS_PROVIDER_CONFIG } from "../../src/shared/constants/ttsProviders.js";

function wavResponse() {
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, ...new Array(100).fill(0)]);
  return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/wav" } });
}

beforeEach(() => {
  mocks.fetch.mockReset();
});

describe("Ollama Local TTS", () => {
  it("posts to /v1/audio/speech with model, input, voice, and response_format", async () => {
    mocks.fetch.mockResolvedValueOnce(wavResponse());

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon/Zoey",
      input: "Hello from Ollama Phonon",
      credentials: null,
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    expect(mocks.fetch.mock.calls[0][0]).toBe("http://localhost:11434/v1/audio/speech");
    expect(mocks.fetch.mock.calls[0][1].method).toBe("POST");

    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("phonon");
    expect(sent.voice).toBe("Zoey");
    expect(sent.input).toBe("Hello from Ollama Phonon");
    // Ollama upstream only accepts wav/pcm; format is normalized to wav
    expect(sent.response_format).toBe("wav");

    const body = await result.response.json();
    expect(body.format).toBe("wav");
    expect(body.audio).toEqual(expect.any(String));
  });

  it("uses default voice when only model is provided", async () => {
    mocks.fetch.mockResolvedValueOnce(wavResponse());

    await handleTtsCore({
      provider: "ollama-local",
      model: "phonon",
      input: "Testing default voice",
      responseFormat: "mp3",
    });

    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("phonon");
    expect(sent.voice).toBe("default");
    expect(sent.response_format).toBe("wav");
  });

  it("maps standalone voice name to phonon model when phonon prefix is omitted", async () => {
    mocks.fetch.mockResolvedValueOnce(wavResponse());

    await handleTtsCore({
      provider: "ollama-local",
      model: "Zoey",
      input: "Testing standalone voice",
      responseFormat: "wav",
    });

    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("phonon:multilingual");
    expect(sent.voice).toBe("Zoey");
    expect(sent.response_format).toBe("wav");
  });

  it("requests pcm verbatim when the client asks for raw pcm", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(Buffer.alloc(256, 1), { status: 200, headers: { "Content-Type": "audio/pcm" } })
    );

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon",
      input: "Raw pcm please",
      responseFormat: "pcm",
    });

    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.response_format).toBe("pcm");
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("audio/pcm");
  });

  it("resolves custom baseUrl from credentials when configured", async () => {
    mocks.fetch.mockResolvedValueOnce(wavResponse());

    await handleTtsCore({
      provider: "ollama-local",
      model: "phonon/Easton",
      input: "Remote Ollama instance",
      credentials: {
        providerSpecificData: {
          baseUrl: "http://192.168.1.100:11434",
        },
        apiKey: "custom-token",
      },
      responseFormat: "wav",
    });

    expect(mocks.fetch.mock.calls[0][0]).toBe("http://192.168.1.100:11434/v1/audio/speech");
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer custom-token");

    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(sent.voice).toBe("Easton");
  });

  it("falls back to another installed phonon tag on 404 via /api/tags", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response("model not found", { status: 404 })) // initial /v1/audio/speech
      .mockResolvedValueOnce(Response.json({ models: [{ name: "phonon:en" }, { name: "llama3" }] })) // /api/tags
      .mockResolvedValueOnce(wavResponse()); // retry /v1/audio/speech

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon:40m-en/Zoey",
      input: "Fallback tag",
      responseFormat: "wav",
    });

    expect(result.success).toBe(true);
    expect(mocks.fetch.mock.calls[1][0]).toBe("http://localhost:11434/api/tags");
    const retry = JSON.parse(mocks.fetch.mock.calls[2][1].body);
    expect(retry.model).toBe("phonon:en");
    expect(retry.voice).toBe("Zoey");
  });

  it("falls back to the default voice when the checkpoint lacks the requested one", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response('{"error":{"message":"voice \'Zoey\' not found in checkpoint"}}', { status: 400 }))
      .mockResolvedValueOnce(wavResponse());

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon/Zoey",
      input: "Fallback voice",
      responseFormat: "wav",
    });

    expect(result.success).toBe(true);
    const retry = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(retry.voice).toBe("default");
    expect(retry.model).toBe("phonon");
  });

  it("surfaces an upstream error body when no fallback applies", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('{"error":{"message":"unsupported response_format"}}', { status: 400 })
    );

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon",
      input: "Should fail",
      responseFormat: "wav",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("unsupported response_format");
  });

  it("handles connection failure with informative error message", async () => {
    const error = new Error("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    mocks.fetch.mockRejectedValueOnce(error);

    const result = await handleTtsCore({
      provider: "ollama-local",
      model: "phonon",
      input: "Should fail gracefully",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot connect to Ollama at http://localhost:11434");
    expect(result.error).toContain("ollama serve");
  });

  it("exposes Phonon TTS models + preset voices in the TTS catalog", () => {
    const entries = buildTtsProviderModels();

    const modelIds = entries["ollama-local-tts-models"].map((model) => model.id);
    expect(modelIds).toContain("phonon:latest");
    expect(modelIds).toContain("phonon");
    expect(modelIds).toContain("phonon:multilingual");
    expect(modelIds).toContain("phonon:40m-multilingual");
    expect(modelIds).toContain("phonon:en");
    expect(modelIds).toContain("phonon:31m-en");
    expect(modelIds).toContain("phonon:40m-en");
    expect(modelIds).toContain("phonon:de");
    expect(modelIds).toContain("phonon:40m-de");
    expect(modelIds).toContain("phonon:es");
    expect(modelIds).toContain("phonon:40m-es");
    expect(modelIds).toContain("phonon:fr");
    expect(modelIds).toContain("phonon:40m-fr");
    expect(modelIds).toContain("phonon:pt");
    expect(modelIds).toContain("phonon:40m-pt");

    const englishVoices = getTtsVoicesForModel("ollama-local", "phonon:40m-en");
    expect(englishVoices.length).toBe(38);
    expect(englishVoices.map((v) => v.id)).toContain("default");
    expect(englishVoices.map((v) => v.id)).toContain("Zoey");
    expect(englishVoices.map((v) => v.id)).toContain("Easton");
    expect(englishVoices.map((v) => v.id)).toContain("Freya");
    expect(englishVoices.map((v) => v.id)).toContain("Azgorath");

    const deVoices = getTtsVoicesForModel("ollama-local", "phonon:de");
    expect(deVoices.map((v) => v.id)).toEqual(["default"]);

    // Registry TTS models are exposed under the provider id too
    const registryTts = (PROVIDER_MODELS["ollama-local"] || []).filter((m) => m.kind === "tts");
    expect(registryTts.length).toBe(15);
  });

  it("wires ollama-local into media-providers TTS (serviceKind, adapter, UI config)", () => {
    expect(AI_PROVIDERS["ollama-local"].serviceKinds).toContain("tts");
    expect(AI_PROVIDERS["ollama-local"].ttsConfig.baseUrl).toBe("http://localhost:11434/v1/audio/speech");
    expect(getTtsAdapter("ollama-local")).toBeTruthy();

    const ttsProviders = getProvidersByKind("tts");
    const ollamaEntry = ttsProviders.find((p) => p.id === "ollama-local");
    expect(ollamaEntry).toBeTruthy();

    expect(TTS_PROVIDER_CONFIG["ollama-local"].hasModelSelector).toBe(true);
    expect(TTS_PROVIDER_CONFIG["ollama-local"].hasVoiceIdInput).toBe(true);
    expect(TTS_PROVIDER_CONFIG["ollama-local"].defaultVoiceId).toBe("default");
    expect(TTS_PROVIDER_CONFIG["ollama-local"].voicesPerModel).toBe(true);
    expect(TTS_PROVIDER_CONFIG["ollama-local"].defaultFormat).toBe("wav");
    expect(TTS_PROVIDER_CONFIG["ollama-local"].formatOptions).toEqual([
      { value: "wav", label: "WAV (Binary)" },
      { value: "pcm", label: "PCM (Raw)" },
    ]);
  });
});
