import { it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), core: vi.fn(), modelInfo: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null,
  getProviderCredentials: mocks.get,
  markAccountUnavailable: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({}),
  getCustomModels: async () => [],
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.modelInfo,
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: "test-key", lease: null }),
  runWithClientKeyLease: (_lease, fn) => fn(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: (_key, fn) => fn(),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  handleTtsCore: mocks.core,
}));

import { handleTts } from "@/sse/handlers/tts.js";

function request(body, search = "") {
  return new Request(`http://localhost/v1/audio/speech${search}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modelInfo.mockImplementation(async (modelStr) => {
    const [provider, ...rest] = String(modelStr).split("/");
    return { provider, model: rest.join("/") || "" };
  });
  mocks.get.mockResolvedValue(null);
  mocks.core.mockResolvedValue({ success: true, response: Response.json({ ok: true }) });
});

it("synthesizes for ollama-local without any stored connection", async () => {
  const res = await handleTts(request({ model: "ollama-local/phonon", input: "hello" }));
  expect(res.status).toBe(200);
  expect(mocks.get).toHaveBeenCalledWith("ollama-local", expect.any(Set), "phonon", expect.anything());
  expect(mocks.core).toHaveBeenCalledTimes(1);
  expect(mocks.core.mock.calls[0][0]).toMatchObject({
    provider: "ollama-local",
    model: "phonon",
    credentials: null,
    input: "hello",
  });
});

it("returns 400 for other connection-backed providers when no credentials exist", async () => {
  const res = await handleTts(request({ model: "elevenlabs/eleven_flash_v2_5", input: "hello" }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.message).toContain("No credentials for provider: elevenlabs");
  expect(mocks.core).not.toHaveBeenCalled();
});

it("honors response_format from the body when the query string omits it", async () => {
  const res = await handleTts(request({ model: "ollama-local/phonon", input: "hi", response_format: "pcm" }));
  expect(res.status).toBe(200);
  expect(mocks.core.mock.calls[0][0].responseFormat).toBe("pcm");
});

it("lets the query string response_format win over the body", async () => {
  const res = await handleTts(request({ model: "ollama-local/phonon", input: "hi", response_format: "pcm" }, "?response_format=wav"));
  expect(res.status).toBe(200);
  expect(mocks.core.mock.calls[0][0].responseFormat).toBe("wav");
});

it("maps an ollama-local core failure to an error response", async () => {
  mocks.core.mockResolvedValueOnce({ success: false, status: 502, error: "Cannot connect to Ollama" });
  const res = await handleTts(request({ model: "ollama-local/phonon", input: "hello" }));
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error.message).toContain("Cannot connect to Ollama");
});
