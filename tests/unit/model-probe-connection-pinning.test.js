import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(),
  clearAccountError: vi.fn(),
  gateRequireApiKey: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleSttCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: vi.fn(),
  markAccountUnavailable: mocks.markAccountUnavailable,
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));

vi.mock("open-sse/handlers/sttCore.js", () => ({
  handleSttCore: mocks.handleSttCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("@/sse/utils/requireApiKeyGate.js", () => ({
  gateRequireApiKey: mocks.gateRequireApiKey,
}));

vi.mock("@/shared/utils/cliToken.js", () => ({
  hasValidCliToken: vi.fn(),
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    test: { serviceKinds: ["stt"], sttConfig: { authType: "bearer" } },
  },
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn((value) => value),
  request: vi.fn(),
  warn: vi.fn(),
}));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");

describe("model probe connection pinning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.gateRequireApiKey.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "test", model: "model-1" });
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "connection-1",
      connectionName: "Test Connection",
      providerSpecificData: {},
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleEmbeddingsCore.mockResolvedValue({ success: true, response: Response.json({ data: [] }) });
    mocks.handleSttCore.mockResolvedValue({ success: true, response: Response.json({ text: "ok" }) });
  });

  it("pins embedding probes to the requested connection", async () => {
    const request = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-connection-id": "connection-1",
        "x-switchboard-strict-connection": "1",
      },
      body: JSON.stringify({ model: "test/model-1", input: "test" }),
    });

    await handleEmbeddings(request);

    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "test",
      expect.any(Set),
      "model-1",
      { preferredConnectionId: "connection-1", strictPreferredConnection: true },
    );
  });

  it("pins speech-to-text probes to the requested connection", async () => {
    const form = new FormData();
    form.append("model", "test/model-1");
    form.append("file", new Blob(["audio"], { type: "audio/wav" }), "test.wav");
    const request = new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "x-connection-id": "connection-1",
        "x-switchboard-strict-connection": "1",
      },
      body: form,
    });

    await handleStt(request);

    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "test",
      expect.any(Set),
      "model-1",
      { preferredConnectionId: "connection-1", strictPreferredConnection: true },
    );
  });
});
