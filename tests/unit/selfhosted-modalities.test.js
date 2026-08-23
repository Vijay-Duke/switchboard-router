import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const assertPublicUrlResolved = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("../../open-sse/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ noAuth: true })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));

import selfhostedStt from "../../open-sse/providers/registry/selfhosted-stt.js";
import selfhostedTts from "../../open-sse/providers/registry/selfhosted-tts.js";
import selfhostedEmbedding from "../../open-sse/providers/registry/selfhosted-embedding.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function audioForm() {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" }));
  return form;
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  assertPublicUrlResolved.mockReset().mockResolvedValue(undefined);
});

describe("self-hosted provider registry", () => {
  it.each([
    [selfhostedStt, "stt"],
    [selfhostedTts, "tts"],
    [selfhostedEmbedding, "embedding"],
  ])("declares %s as local media with an outbound identity", (provider, kind) => {
    expect(provider.serviceKinds).toEqual([kind]);
    expect(provider.noAuth).toBe(true);
    expect(provider[`${kind}Config`].identity).toBe("openai-node");
  });
});

describe("self-hosted STT", () => {
  it("requires and uses the connection endpoint with optional bearer auth", async () => {
    const missing = await handleSttCore({
      provider: "selfhosted-stt",
      model: "whisper-1",
      formData: audioForm(),
      credentials: {},
      sttConfig: selfhostedStt.sttConfig,
    });
    expect(missing).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValueOnce(Response.json({ text: "hello" }));
    const result = await handleSttCore({
      provider: "selfhosted-stt",
      model: "whisper-1",
      formData: audioForm(),
      credentials: { apiKey: "optional", providerSpecificData: { baseUrl: "http://127.0.0.1:8080/v1/audio/transcriptions" } },
      sttConfig: selfhostedStt.sttConfig,
    });

    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/audio/transcriptions",
      expect.objectContaining({
        identity: "openai-node",
        provider: "selfhosted-stt",
        headers: { Authorization: "Bearer optional" },
      }),
    );
  });
});

describe("self-hosted TTS", () => {
  it("requires the connection endpoint and uses the wrapped fetch without a key", async () => {
    const missing = await handleTtsCore({
      provider: "selfhosted-tts",
      model: "kokoro",
      input: "hello",
      credentials: {},
    });
    expect(missing).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValueOnce(new Response(new Uint8Array(128), {
      headers: { "content-type": "audio/mpeg" },
    }));
    const result = await handleTtsCore({
      provider: "selfhosted-tts",
      model: "kokoro/af_heart",
      input: "hello",
      credentials: { providerSpecificData: { baseUrl: "http://192.168.1.20:8880/v1" } },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("http://192.168.1.20:8880/v1/audio/speech");
    expect(init).toMatchObject({ identity: "openai-node", provider: "selfhosted-tts" });
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ model: "kokoro", voice: "af_heart", input: "hello" });
  });
});

describe("self-hosted embeddings", () => {
  it("never falls back to cloud and permits the operator's private endpoint", async () => {
    const missing = await handleEmbeddingsCore({
      body: { input: "private text" },
      modelInfo: { provider: "selfhosted-embedding", model: "embedding" },
      credentials: {},
      log,
    });
    expect(missing).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValueOnce(Response.json({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1] }],
      model: "embedding",
      usage: {},
    }));
    const result = await handleEmbeddingsCore({
      body: { input: "private text" },
      modelInfo: { provider: "selfhosted-embedding", model: "embedding" },
      credentials: { providerSpecificData: { baseUrl: "http://10.0.0.4:8080/v1" } },
      log,
    });

    expect(result.success).toBe(true);
    expect(assertPublicUrlResolved).not.toHaveBeenCalled();
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "http://10.0.0.4:8080/v1/embeddings",
      expect.objectContaining({ identity: "openai-node", provider: "selfhosted-embedding" }),
    );
  });
});
