/**
 * Upstream error forwarding for Claude-format clients (gateway guide):
 * Claude Code's capability-rejection recovery matches on the upstream's
 * exact error wording (e.g. a message starting with `Unexpected value(s)`
 * for a rejected anthropic-beta value). Wrapping the error in the
 * gateway's own envelope — or prefixing it — breaks that recovery, so a
 * Claude-format upstream's error body must reach a Claude-format client
 * byte-for-byte. The internal error string used for account fallback and
 * logs keeps its existing prefixed form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUpstreamError, createErrorResult } from "../../open-sse/utils/error.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ noAuth: false, execute: executeMock, refreshCredentials: vi.fn() })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logError: vi.fn(), logProviderResponse: vi.fn(), close: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => "claude"),
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
  default: vi.fn(), proxyAwareFetch: vi.fn(), proxyOptionsFromCredentials: vi.fn(() => ({})),
}));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""), formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((d) => d),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  settleUsageStats: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const UPSTREAM_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Unexpected value(s) `safeguards-2099-01-01` for the `anthropic-beta` header. Please consult our documentation at docs.claude.com",
  },
  request_id: "req_123",
});

describe("parseUpstreamError", () => {
  it("returns the raw upstream body alongside the extracted message", async () => {
    const res = new Response(UPSTREAM_400, { status: 400, headers: { "content-type": "application/json" } });
    const parsed = await parseUpstreamError(res);
    expect(parsed.statusCode).toBe(400);
    expect(parsed.message).toMatch(/^Unexpected value\(s\)/);
    expect(parsed.rawBody).toBe(UPSTREAM_400);
  });
});

describe("createErrorResult with a raw upstream body", () => {
  it("forwards the body byte-for-byte while keeping the internal error string", async () => {
    const result = createErrorResult(400, "[400]: Unexpected value(s) `x`", undefined, UPSTREAM_400);
    expect(result.status).toBe(400);
    expect(result.error).toBe("[400]: Unexpected value(s) `x`");
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe(UPSTREAM_400);
  });

  it("falls back to the gateway envelope for a non-JSON raw body", async () => {
    const result = createErrorResult(502, "[502]: Bad Gateway", undefined, "<html>proxy error</html>");
    const body = JSON.parse(await result.response.text());
    expect(body.error.message).toBe("[502]: Bad Gateway");
  });

  it("without a raw body the envelope is unchanged", async () => {
    const result = createErrorResult(429, "[429]: slow down");
    const body = JSON.parse(await result.response.text());
    expect(body.error.message).toBe("[429]: slow down");
    expect(result.error).toBe("[429]: slow down");
  });
});

describe("chatCore upstream error forwarding", () => {
  beforeEach(() => executeMock.mockReset());

  function options(overrides = {}) {
    const body = {
      model: "claude/claude-sonnet-5", stream: false,
      messages: [{ role: "user", content: "hello" }],
    };
    return {
      body,
      sourceFormatOverride: "claude",
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { apiKey: "key" },
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { accept: "application/json" } },
      connectionId: "test-connection",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    };
  }

  it("returns the Anthropic 400 body verbatim to a Claude client", async () => {
    executeMock.mockImplementation(async () => ({
      response: new Response(UPSTREAM_400, { status: 400, headers: { "content-type": "application/json" } }),
      url: "https://api.anthropic.com/v1/messages", headers: {}, transformedBody: {},
    }));
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^\[400\]: Unexpected value\(s\)/);
    expect(await result.response.text()).toBe(UPSTREAM_400);
  });

  it("keeps the gateway envelope when the target is not Claude format", async () => {
    const openai400 = JSON.stringify({ error: { message: "bad model", type: "invalid_request_error", param: "model", code: "model_not_found" } });
    executeMock.mockImplementation(async () => ({
      response: new Response(openai400, { status: 400, headers: { "content-type": "application/json" } }),
      url: "https://openrouter.example/chat", headers: {}, transformedBody: {},
    }));
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options({
      modelInfo: { provider: "openrouter", model: "openai/gpt-4o" },
    }));
    const body = JSON.parse(await result.response.text());
    expect(body.error.message).toMatch(/^\[400\]: bad model/);
  });
});
