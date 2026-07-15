import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyJudgeScoreByRequestId: vi.fn(),
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

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

function claudeRequest(model) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer native-claude-oauth",
      "x-switchboard-key": "sk-switchboard",
      "x-switchboard-claude-mode": "pass-through",
      "user-agent": "claude-code/2.1.129",
      "x-app": "cli",
    },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      stream: false,
    }),
  });
}

describe("Claude handler credential isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: {},
      tokenSaver: { vault: false },
    });
    mocks.gateRequireApiKey.mockResolvedValue(null);
    mocks.getComboModels.mockResolvedValue(null);
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  });

  it("keeps direct Anthropic OAuth ephemeral and disables refresh, persistence, and fallback", async () => {
    let receivedCredentials;
    let upstreamHeaders;
    mocks.getModelInfo.mockResolvedValue({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    mocks.handleChatCore.mockImplementationOnce(async (options) => {
      receivedCredentials = options.credentials;
      upstreamHeaders = new DefaultExecutor("anthropic").buildHeaders({
        ...options.credentials,
        rawHeaders: options.clientRawRequest.headers,
      }, false);

      await options.onCredentialsRefreshed({ accessToken: "rotated-token" });
      await options.onRequestSuccess();
      await options.onUpstreamEmptyExhausted("empty stream", Date.now() + 1_000);

      return {
        success: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
        status: 401,
        error: "unauthorized",
      };
    });

    const response = await handleChat(claudeRequest("claude-sonnet-4-20250514"));

    expect(response.status).toBe(401);
    expect(receivedCredentials).toMatchObject({
      accessToken: "native-claude-oauth",
      connectionName: "Claude Code subscription",
      ephemeral: true,
    });
    expect(receivedCredentials).not.toHaveProperty("apiKey");
    expect(upstreamHeaders.Authorization).toBe("Bearer native-claude-oauth");
    expect(upstreamHeaders["x-api-key"]).toBeUndefined();
    expect(upstreamHeaders["x-switchboard-key"]).toBeUndefined();

    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("routes a Claude-shaped OpenAI alias with stored credentials only", async () => {
    const storedCredentials = {
      apiKey: "stored-openai-key",
      connectionId: "openai-connection",
      connectionName: "OpenAI account",
      providerSpecificData: {},
    };
    let receivedCredentials;
    let upstreamHeaders;
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-5.6" });
    mocks.getProviderCredentials.mockResolvedValue(storedCredentials);
    mocks.handleChatCore.mockImplementationOnce(async (options) => {
      receivedCredentials = options.credentials;
      upstreamHeaders = new DefaultExecutor("openai").buildHeaders({
        ...options.credentials,
        rawHeaders: options.clientRawRequest.headers,
      }, false);
      await options.onRequestSuccess();
      return { success: true, response: Response.json({ ok: true }) };
    });

    const response = await handleChat(claudeRequest("claude-switchboard-gpt"));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "openai",
      expect.any(Set),
      "gpt-5.6",
      { preferredConnectionId: null, strictPreferredConnection: false },
    );
    expect(mocks.checkAndRefreshToken).toHaveBeenCalledWith("openai", storedCredentials);
    expect(receivedCredentials.apiKey).toBe("stored-openai-key");
    expect(receivedCredentials.accessToken).toBeUndefined();
    expect(upstreamHeaders.Authorization).toBe("Bearer stored-openai-key");
    expect(upstreamHeaders.Authorization).not.toContain("native-claude-oauth");
    expect(upstreamHeaders["x-switchboard-key"]).toBeUndefined();
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "openai-connection",
      storedCredentials,
      "gpt-5.6",
    );
    expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
