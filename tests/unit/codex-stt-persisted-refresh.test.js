import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn(), latest: vi.fn(), fetch: vi.fn(), refresh: vi.fn(), convert: vi.fn() }));

const credentials = {
  connectionId: "offline-connection",
  authType: "oauth",
  accessToken: "offline-old-token",
  refreshToken: "offline-refresh",
  expiresAt: "2000-01-01T00:00:00.000Z",
  connectionName: "Offline Codex",
  providerSpecificData: { workspaceId: "workspace", customMetadata: "preserve-me" },
};

vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({}),
  getCustomModels: async () => [],
  getProviderConnectionById: mocks.latest,
  updateProviderConnection: mocks.update,
  updateProviderConnectionCredentialsIfCurrent: vi.fn(async () => null),
  updateProviderConnectionStatusIfCurrent: vi.fn(async () => null),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null,
  getProviderCredentials: async () => credentials,
  clearAccountError: async () => {},
  markAccountUnavailable: async () => ({ shouldFallback: false }),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "codex", model: "transcribe" }),
  getComboModels: async () => ({}),
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: null, lease: null }),
  runWithClientKeyLease: (_lease, fn) => fn(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: (_key, fn) => fn(),
}));
// Conversion itself is covered by codex-stt-transport (real ffmpeg); this file
// exercises the persisted-credential flow, so conversion is stubbed — which
// also keeps the test runnable on hosts without an ffmpeg binary.
vi.mock("../../open-sse/handlers/codexSttAudio.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, convertAudio: mocks.convert };
});
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetch,
  proxyOptionsFromCredentials: () => ({}),
  resolveProxyUrl: () => null,
  getDispatcher: async () => null,
}));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  shouldRefreshCredentials: () => true,
  refreshProviderCredentials: mocks.refresh,
  getCredentialRefreshReceipt: () => null,
}));

const { POST } = await import("../../src/app/api/v1/audio/transcriptions/route.js");

function request() {
  const pcm = Buffer.alloc(44 + 4800);
  pcm.write("RIFF"); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(24000, 24); pcm.writeUInt32LE(48000, 28); pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(4800, 40);
  const form = new FormData();
  form.set("model", "cx/transcribe");
  form.set("file", new Blob([pcm], { type: "audio/wav" }), "input.wav");
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latest.mockResolvedValue(null);
  mocks.update.mockResolvedValue({ id: credentials.connectionId });
  mocks.convert.mockImplementation(async () => new Blob([Buffer.alloc(44 + 480)], { type: "audio/wav" }));
  mocks.refresh.mockResolvedValue({
    accessToken: "offline-refreshed-token",
    refreshToken: "offline-rotated-refresh",
    expiresIn: 3600,
    providerSpecificData: { chatgptAccountId: "account" },
    lastRefreshAt: new Date().toISOString(),
  });
  mocks.fetch.mockImplementation(async (_url, options) => {
    mocks.fetch.lastOptions = options;
    return Response.json({ text: "persisted" });
  });
});

it("uses the real persisted refresh service before sending expired-account OAuth audio", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "persisted" });
  // Persisted merged credentials: rotated tokens with existing account data preserved.
  expect(mocks.update).toHaveBeenCalledWith("offline-connection", expect.objectContaining({
    accessToken: "offline-refreshed-token",
    refreshToken: "offline-rotated-refresh",
    providerSpecificData: { workspaceId: "workspace", customMetadata: "preserve-me", chatgptAccountId: "account" },
  }));
  // The refreshed token — not the expired stored one — is what leaves the process.
  expect(mocks.fetch.lastOptions.headers.Authorization).toBe("Bearer offline-refreshed-token");
  expect(mocks.fetch.lastOptions.headers["ChatGPT-Account-Id"]).toBe("workspace");
  expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]);
});

it("rejects invalid refreshed tokens before contacting transcription upstream", async () => {
  mocks.refresh.mockResolvedValue({ accessToken: "invalid\r\ncredential", expiresIn: 3600 });
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("credential");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
