import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyJudgeScoreByRequestId: vi.fn(),
  authorizeClientKeyRequest: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  clearAccountError: vi.fn(),
  gateRequireApiKey: vi.fn(),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  handleChatCore: vi.fn(),
  markAccountUnavailable: vi.fn(),
  setRoutingWriteHook: vi.fn(),
  runWithClientKeyLease: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  getUsageStats: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderQuotaHeadroom: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db/repos/routingRepo.js", () => ({
  insertRoutingEvent: vi.fn(),
  applyJudgeScoreByRequestId: mocks.applyJudgeScoreByRequestId,
  setUserRatingByRequestId: vi.fn(),
  getPromotedLearningVersion: vi.fn(async () => null),
  getLearningVersionById: vi.fn(async () => null),
  getClusterWorkerStats: vi.fn(async () => []),
  getGlobalModelStats: vi.fn(async () => []),
  getClusterLatencyP50: vi.fn(async () => null),
  getProviderLatency: vi.fn(async () => ({})),
  getRoutingEvents: vi.fn(async () => []),
  createLearningVersion: vi.fn(async () => null),
  countRoutingEvents: vi.fn(async () => 0),
  listCombosWithRoutingEvents: vi.fn(async () => []),
  getLastScheduledLearnAt: vi.fn(async () => null),
  setRoutingWriteHook: mocks.setRoutingWriteHook,
}));

vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn((request) => request.headers.get("x-switchboard-key")),
  isValidApiKey: vi.fn(async () => true),
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

vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: mocks.authorizeClientKeyRequest,
  runWithClientKeyLease: mocks.runWithClientKeyLease,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn((value) => value),
  request: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

function request(signal) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-4.1", messages: [{ role: "user", content: "hello" }], stream: false }),
    signal,
  });
}
const account = { connectionId: "synthetic", connectionName: "synthetic", apiKey: "synthetic-key" };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handleChatCore.mockReset();
  mocks.getProviderCredentials.mockReset();
  mocks.checkAndRefreshToken.mockReset();
  mocks.authorizeClientKeyRequest.mockResolvedValue({ ok: true, clientKeyId: null, lease: null });
  mocks.runWithClientKeyLease.mockImplementation(async (_lease, work) => work());
  mocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategies: {}, tokenSaver: { vault: false } });
  mocks.gateRequireApiKey.mockResolvedValue(null);
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4.1" });
  mocks.getProviderCredentials.mockResolvedValue(account);
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
});
describe("account loop caller cancellation", () => {
  it("does not bench or select a fallback when a cancelled core reports a generic transport error", async () => {
    const controller = new AbortController();
    mocks.handleChatCore.mockImplementationOnce(async () => {
      controller.abort();
      return { success: false, status: 502, error: "transport closed", response: new Response("closed", { status: 502 }) };
    }).mockResolvedValue({ success: true, response: new Response("fallback") });
    const result = await handleChat(request(controller.signal));
    expect(result.status).toBe(499);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
  it("does not refresh or execute when credential selection finishes after cancellation", async () => {
    const controller = new AbortController(), selected = deferred();
    mocks.getProviderCredentials.mockReturnValueOnce(selected.promise);
    const pending = handleChat(request(controller.signal));
    await vi.waitFor(() => expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1));
    controller.abort(); selected.resolve(account);
    expect((await pending).status).toBe(499);
    expect(mocks.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
  it("does not execute when shared token refresh finishes after cancellation", async () => {
    const controller = new AbortController(), refreshed = deferred();
    mocks.checkAndRefreshToken.mockReturnValueOnce(refreshed.promise);
    const pending = handleChat(request(controller.signal));
    await vi.waitFor(() => expect(mocks.checkAndRefreshToken).toHaveBeenCalledTimes(1));
    controller.abort(); refreshed.resolve(account);
    expect((await pending).status).toBe(499);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
  it("does not mark an internal router cancellation as an account failure", async () => {
    mocks.handleChatCore.mockResolvedValueOnce({ success: false, status: 499, error: "Request aborted", response: new Response("aborted", { status: 499 }) });
    expect((await handleChat(request())).status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
