import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock, logTargetRequest, identityMock } = vi.hoisted(() => ({
  identityMock: vi.fn(async (body) => ({ ...body, metadata: { user_id: "verified-account-identity" } })),
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
  logTargetRequest: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ noAuth: false, execute: executeMock, refreshCredentials: refreshCredentialsMock })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest,
    logError: vi.fn(),
    logProviderResponse: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn((_headers, body) => body?.thread ? "claude" : null),
  harvestDetectedClient: vi.fn(() => false),
  isNativePassthrough: vi.fn((client, provider) => client === "claude" && provider === "claude"),
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(async (fn) => fn()),
  isUnrecoverableRefreshError: vi.fn(() => false),
  parseVertexSaJson: vi.fn(() => null),
  refreshVertexToken: vi.fn(),
  refreshGoogleToken: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
  proxyOptionsFromCredentials: vi.fn(() => ({})),
}));
vi.mock("../../open-sse/translator/formats/claude.js", async importOriginal => ({ ...await importOriginal(), normalizeClaudePassthrough: vi.fn((await importOriginal()).normalizeClaudePassthrough) }));
vi.mock("../../open-sse/utils/claudeCloaking.js", async importOriginal => ({ ...await importOriginal(), applyCloakingWithIdentity: identityMock }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/vault.js", async original => ({ ...await original(), storeToVault: vi.fn() }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  settleUsageStats: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

function requestOptions() {
  const body = { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider: "openrouter", model: "openai/gpt-4o" },
    credentials: { apiKey: "old-key", accessToken: "old-token", refreshToken: "rt", projectId: "project-1" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function attempt(response, url) {
  return { response, url, headers: { "x-attempt-url": url }, transformedBody: { attemptUrl: url } };
}

describe("per-attempt body snapshot and retry logging (H16/H18)", () => {
  beforeEach(() => {
    executeMock.mockReset();
    refreshCredentialsMock.mockReset();
    logTargetRequest.mockReset();
  });

  it("gives the post-refresh retry the pristine body even when attempt 1 mutated it in place, and logs the retry", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    let pristine = null;
    executeMock
      .mockImplementationOnce(async ({ body }) => {
        pristine = structuredClone(body);
        body.mutatedByAttempt1 = true;
        delete body.contents;
        return attempt(new Response("unauthorized", { status: 401 }), "https://upstream.test/attempt-1");
      })
      .mockImplementationOnce(async () => attempt(
        new Response("<html>not sse</html>", { status: 200, headers: { "content-type": "text/html" } }),
        "https://upstream.test/attempt-2",
      ));
    refreshCredentialsMock.mockResolvedValue({ accessToken: "new-token" });

    await handleChatCore(requestOptions());

    expect(executeMock).toHaveBeenCalledTimes(2);
    const retryBody = executeMock.mock.calls[1][0].body;
    expect(retryBody).toEqual(pristine);
    expect(retryBody.mutatedByAttempt1).toBeUndefined();
    expect(retryBody).not.toBe(executeMock.mock.calls[0][0].body);

    expect(logTargetRequest).toHaveBeenCalledTimes(2);
    expect(logTargetRequest.mock.calls[1][0]).toBe("https://upstream.test/attempt-2");
    expect(logTargetRequest.mock.calls[1][1]).toEqual({ "x-attempt-url": "https://upstream.test/attempt-2" });
  });
});

it("rebinds translated Claude OAuth identity using a declared session identifier", async () => {
  executeMock.mockReset(); identityMock.mockClear();
  executeMock.mockResolvedValue(attempt(new Response("bad fixture", { status: 400 }), "https://upstream.test/messages"));
  const options = requestOptions();
  options.modelInfo = { provider: "claude", model: "claude-sonnet-5-5" };
  options.body.model = "claude/claude-sonnet-5-5";
  options.credentials = { accessToken: "sk-ant-oat-synthetic-token", connectionId: "synthetic-account" };
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore(options);
  expect(identityMock).toHaveBeenCalledOnce();
  expect(identityMock.mock.calls[0][2]).toEqual(expect.any(String));
  expect(executeMock.mock.calls[0][0].body.metadata.user_id).toBe("verified-account-identity");
});

it("marks non-Claude translated stages as inapplicable instead of reporting deleted tool history", async () => {
  executeMock.mockReset();
  executeMock.mockResolvedValue(attempt(new Response("fixture rejection", { status: 400 }), "https://upstream.test/chat"));
  const options = requestOptions();
  options.body.messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "actual result" }] },
  ];
  options.sourceFormatOverride = "claude";
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const { buildRequestDetail } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
  buildRequestDetail.mockClear();
  await handleChatCore(options);
  const stages = buildRequestDetail.mock.calls[0][0].request.toolHistoryDiagnostics;
  expect(stages[0]).toMatchObject({ stage: "inbound", toolCalls: 1, toolResults: 1 });
  expect(stages.find(x => x.stage === "normalized")).toMatchObject({ notApplicable: true, format: "openai" });
  expect(stages.filter(x => x.notApplicable).every(x => x.toolCalls === undefined)).toBe(true);
});

it("dispatches provider-owned Claude delta tool results unchanged with all token savers enabled", async () => {
  executeMock.mockReset();
  executeMock.mockImplementation(async ({ body }) => ({ ...attempt(new Response("fixture rejection", { status: 400 }), "https://upstream.test/messages"), transformedBody: body }));
  const options = requestOptions();
  options.modelInfo = { provider: "claude", model: "claude-opus-5-5" };
  options.sourceFormatOverride = "claude";
  options.body = {
    model: "claude/claude-opus-5-5", stream: true,
    thread: { type: "continue", previous_message_id: "msg_provider_prior" },
    safeguards: { opaque: "preserve" }, tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_provider_prior", content: "actual successful tool output" }] },
      { role: "system", content: [{ type: "text", text: "concise reminder" }] },
    ],
  };
  Object.assign(options, { vaultEnabled: true, vaultConversationId: "synthetic-scope", rtkEnabled: true, headroomEnabled: true, cavemanEnabled: true, cavemanLevel: "full", ponytailEnabled: true, ponytailLevel: "full", pxpipeEnabled: true, providerThinking: { mode: "off" } });
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const { storeToVault } = await import("../../open-sse/rtk/vault.js");
  const { compressMessages } = await import("../../open-sse/rtk/index.js");
  const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
  const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
  const { injectPonytail } = await import("../../open-sse/rtk/ponytail.js");
  [storeToVault, compressMessages, compressWithHeadroom, injectCaveman, injectPonytail].forEach(mock => mock.mockClear());
  await handleChatCore(options);
  const dispatched = executeMock.mock.calls[0][0].body;
  expect(dispatched.thread).toEqual(options.body.thread);
  expect(dispatched.safeguards).toEqual(options.body.safeguards);
  expect(dispatched.messages[0].content).toEqual([
    options.body.messages[0].content[0], { type: "text", text: "concise reminder" },
  ]);
  expect(dispatched.messages).toHaveLength(1);
  expect(dispatched.thinking).toBeUndefined();
  expect(storeToVault).not.toHaveBeenCalled();
  expect(compressMessages.mock.calls[0][1]).toBe(false);
  expect(compressWithHeadroom.mock.calls[0][1].enabled).toBe(false);
  expect(injectCaveman).not.toHaveBeenCalled(); expect(injectPonytail).not.toHaveBeenCalled();
});

it("rejects cross-format stateful Claude routing before dispatch", async () => {
  executeMock.mockReset();
  const options = requestOptions(); options.sourceFormatOverride = "claude";
  options.body.thread = { type: "continue", previous_message_id: "msg_prior" };
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const out = await handleChatCore(options);
  expect(out.status).toBe(400); expect(executeMock).not.toHaveBeenCalled();
});
