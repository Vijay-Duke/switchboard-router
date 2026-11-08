import { it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), refresh: vi.fn(), core: vi.fn(), clear: vi.fn(), mark: vi.fn(), modelInfo: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null,
  getProviderCredentials: mocks.get,
  clearAccountError: mocks.clear,
  markAccountUnavailable: mocks.mark,
}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => ({}),
  getCustomModels: async () => [],
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.modelInfo,
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: async () => ({ ok: true, clientKeyId: "test-key", lease: null }),
  runWithClientKeyLease: (_lease, fn) => fn(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: (_key, fn) => fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.refresh,
}));
vi.mock("open-sse/handlers/sttCore.js", () => ({
  handleSttCore: mocks.core,
}));

import { handleStt } from "@/sse/handlers/stt.js";
import { errorResponse } from "open-sse/utils/error.js";

const credentials = {
  authType: "oauth", accessToken: "initial", refreshToken: "refresh",
  connectionId: "one", connectionName: "Codex Chat",
  providerSpecificData: { workspaceId: "test-account" },
};

function request(model = "cx/transcribe") {
  const form = new FormData();
  form.set("model", model);
  form.set("file", new File(["test"], "a.wav"));
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modelInfo.mockImplementation(async (modelStr) => {
    const model = String(modelStr).split("/").slice(1).join("/") || "transcribe";
    return { provider: "codex", model };
  });
  mocks.get.mockResolvedValue(credentials);
  mocks.refresh.mockImplementation(async (_provider, creds, options) => ({
    ...creds,
    accessToken: options?.force ? "retried" : "refreshed",
  }));
  mocks.mark.mockResolvedValue({ shouldFallback: false });
  mocks.clear.mockResolvedValue(undefined);
  mocks.core.mockResolvedValue({ success: true, response: Response.json({ text: "hello" }) });
});

it("refreshes shared OAuth credentials before dispatching to the STT core", async () => {
  const req = request();
  const response = await handleStt(req);
  expect(response.status).toBe(200);
  expect(mocks.refresh).toHaveBeenCalledWith("codex", credentials);
  expect(mocks.core.mock.calls[0][0]).toMatchObject({ credentials: { accessToken: "refreshed" }, model: "transcribe" });
  expect(mocks.clear).toHaveBeenCalled();
});

it("retries one 401 with a persisted forced refresh", async () => {
  mocks.core
    .mockResolvedValueOnce({ success: false, status: 401, error: "failed", response: errorResponse(401, "failed") })
    .mockResolvedValueOnce({ success: true, response: Response.json({ text: "second" }) });
  expect((await handleStt(request())).status).toBe(200);
  expect(mocks.refresh).toHaveBeenLastCalledWith("codex", expect.objectContaining({ accessToken: "refreshed" }), { force: true });
  expect(mocks.core).toHaveBeenCalledTimes(2);
  expect(mocks.core.mock.calls[1][0]).toMatchObject({ credentials: { accessToken: "retried" } });
});

it("does not retry a 401 when the forced refresh returns the same token", async () => {
  mocks.refresh.mockImplementation(async (_provider, creds) => ({ ...creds, accessToken: "same" }));
  mocks.core.mockResolvedValue({ success: false, status: 401, error: "failed", response: errorResponse(401, "failed") });
  expect((await handleStt(request())).status).toBe(401);
  expect(mocks.core).toHaveBeenCalledTimes(1);
});

it("answers Codex client errors without marking the account unavailable", async () => {
  for (const status of [400, 413, 504]) {
    mocks.core.mockResolvedValueOnce({ success: false, status, error: "client", response: errorResponse(status, "client") });
    expect((await handleStt(request())).status).toBe(status);
  }
  expect(mocks.mark).not.toHaveBeenCalled();
});

it("marks the account and falls back on transport failures", async () => {
  mocks.core.mockResolvedValue({ success: false, status: 502, error: "upstream", response: errorResponse(502, "upstream") });
  mocks.mark.mockResolvedValueOnce({ shouldFallback: false });
  expect((await handleStt(request())).status).toBe(502);
  expect(mocks.mark).toHaveBeenCalledWith("one", 502, "upstream", "codex", "transcribe");
});

it("rejects Codex chat models instead of routing them to the audio endpoint", async () => {
  const response = await handleStt(request("cx/gpt-6-sol"));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { message: "Use model cx/transcribe for Codex STT" } });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.core).not.toHaveBeenCalled();
});
