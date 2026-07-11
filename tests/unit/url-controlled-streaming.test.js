import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { GeminiCLIExecutor } from "../../open-sse/executors/gemini-cli.js";
import { VertexExecutor } from "../../open-sse/executors/vertex.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({ signal: undefined, handleComplete: vi.fn(), handleError: vi.fn() })),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
  parseVertexSaJson: vi.fn(() => null),
  refreshVertexToken: vi.fn(),
  refreshGoogleToken: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
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
}));
vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const URL_CONTROLLED_CASES = [
  ["gemini", "gemini-2.5-flash"],
  ["gemini-cli", "gemini-2.5-pro"],
  ["antigravity", "gemini-pro-agent"],
  ["vertex", "gemini-2.5-flash"],
];

function requestOptions(provider, model) {
  const body = { model, stream: true, messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test-key", accessToken: "test-token", projectId: "project-1" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "text/event-stream" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("URL-controlled streaming transports", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("stop after request capture"));
  });

  it.each(URL_CONTROLLED_CASES)("does not serialize stream for %s/%s", async (provider, model) => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

    await handleChatCore(requestOptions(provider, model));

    const call = executeMock.mock.calls[0][0];
    expect(call.stream).toBe(true);
    expect(call.body.stream).toBeUndefined();
    expect(call.body.request?.stream).toBeUndefined();
  });
});

describe("URL-controlled executor boundaries", () => {
  it("keeps Gemini streaming in its URL, not request JSON", () => {
    const executor = new DefaultExecutor("gemini");
    const body = executor.transformRequest(
      "gemini-2.5-flash",
      { stream: true, contents: [] },
      true,
      {},
    );

    expect(body.stream).toBeUndefined();
    expect(executor.buildUrl("gemini-2.5-flash", true)).toContain(":streamGenerateContent?alt=sse");
  });

  it("removes stream from both Gemini CLI envelope levels", () => {
    const executor = new GeminiCLIExecutor();
    const body = executor.transformRequest(
      "gemini-2.5-pro",
      { stream: true, model: "gemini-2.5-pro", request: { stream: true, contents: [] } },
      true,
      { projectId: "project-1" },
    );

    expect(body.stream).toBeUndefined();
    expect(body.request.stream).toBeUndefined();
    expect(executor.buildUrl("gemini-2.5-pro", true)).toContain(":streamGenerateContent?alt=sse");
  });

  it("removes stream for Vertex Gemini but preserves it for Vertex Partner", () => {
    const gemini = new VertexExecutor("vertex");
    const partner = new VertexExecutor("vertex-partner");

    expect(gemini.transformRequest("gemini-2.5-flash", { stream: true, contents: [] }, true, {}).stream).toBeUndefined();
    expect(partner.transformRequest("zai-org/glm-5-maas", { stream: true, messages: [] }, true, {}).stream).toBe(true);
    expect(gemini.buildUrl("gemini-2.5-flash", true, 0, { apiKey: "key" })).toContain(":streamGenerateContent?alt=sse");
  });
});
