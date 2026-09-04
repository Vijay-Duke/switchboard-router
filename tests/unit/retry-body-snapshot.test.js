import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock, logTargetRequest } = vi.hoisted(() => ({
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
  detectClientTool: vi.fn(() => null),
  harvestDetectedClient: vi.fn(() => false),
  isNativePassthrough: vi.fn(() => false),
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
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
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
