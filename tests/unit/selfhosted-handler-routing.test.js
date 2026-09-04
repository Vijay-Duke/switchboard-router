import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/sse/initOpenSseDeps.js", () => ({}));
vi.mock("@/lib/db/index.js", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: vi.fn(async () => null),
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: vi.fn(async () => ({ ok: true, clientKeyId: "client", lease: null })),
  runWithClientKeyLease: async (_lease, work) => work(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: async (_selection, work) => work(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), error: vi.fn(), info: vi.fn(), request: vi.fn(), warn: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch, proxyOptionsFromCredentials: vi.fn(() => ({})) }));

const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { handleStt } = await import("@/sse/handlers/stt.js");
const { handleTts } = await import("@/sse/handlers/tts.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelInfo.mockImplementation(async (value) => {
    const slash = value.indexOf("/");
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  });
});

describe("self-hosted route connection forwarding", () => {
  it("forwards the saved STT base URL to the adapter", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "stt-connection",
      connectionName: "Local STT",
      providerSpecificData: { baseUrl: "http://127.0.0.1:8080/v1/audio/transcriptions" },
    });
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ text: "hello" }));
    const form = new FormData();
    form.set("model", "selfhosted-stt/whisper-1");
    form.set("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");

    const response = await handleStt(new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/audio/transcriptions",
      expect.any(Object),
      expect.anything(), // per-connection proxy options (H27)
    );
  });

  it("forwards the saved TTS base URL to the adapter", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "tts-connection",
      connectionName: "Local TTS",
      providerSpecificData: { baseUrl: "http://192.168.1.20:8880/v1" },
    });
    mocks.proxyAwareFetch.mockResolvedValue(new Response(new Uint8Array(128), {
      headers: { "content-type": "audio/mpeg" },
    }));

    const response = await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "selfhosted-tts/kokoro", input: "hello" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "http://192.168.1.20:8880/v1/audio/speech",
      expect.any(Object),
      expect.anything(), // per-connection proxy options (H27)
    );
  });

  it("forwards the saved embedding base URL to the adapter", async () => {
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "embedding-connection",
      connectionName: "Local Embeddings",
      providerSpecificData: { baseUrl: "http://10.0.0.4:8080/v1" },
    });
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1] }],
      model: "embedding",
      usage: {},
    }));

    const response = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "selfhosted-embedding/embedding", input: "hello" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "http://10.0.0.4:8080/v1/embeddings",
      expect.any(Object),
      expect.anything(), // per-connection proxy options (H27)
    );
  });
});
