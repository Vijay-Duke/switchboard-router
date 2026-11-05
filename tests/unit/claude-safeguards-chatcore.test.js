/**
 * A native Claude passthrough request carrying `safeguards` (server-side
 * classifier review) must reach the executor with the field intact and
 * without token-saver rewrites: the field is provider-owned and opaque,
 * and body rewrites break its pairing with the anthropic-beta header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({ noAuth: false, execute: executeMock, refreshCredentials: vi.fn() })),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
    logProviderResponse: vi.fn(),
  })),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn((headers) => (/claude-cli\//.test(headers?.["user-agent"] || "") ? "claude" : null)),
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
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/vault.js", async (original) => ({ ...await original(), storeToVault: vi.fn() }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
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

describe("safeguards passthrough in chatCore", () => {
  beforeEach(() => executeMock.mockReset());

  it("dispatches safeguards unchanged with token savers disabled", async () => {
    // Defensive `arg?.body`: vitest cleanup hooks invoke this mock once
    // with no argument after the test body has already passed.
    executeMock.mockImplementation(async (arg) => {
      return {
        response: new Response("fixture rejection", { status: 400 }),
        url: "https://upstream.test/messages",
        headers: {},
        transformedBody: arg?.body,
      };
    });
    const body = {
      model: "claude/claude-sonnet-5",
      stream: true,
      safeguards: { opaque: "preserve" },
      tools: [{ name: "Bash", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "run ls" }],
    };
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const { storeToVault } = await import("../../open-sse/rtk/vault.js");
    const { compressMessages } = await import("../../open-sse/rtk/index.js");
    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
    const { injectPonytail } = await import("../../open-sse/rtk/ponytail.js");
    const { dedupeTools } = await import("../../open-sse/utils/toolDeduper.js");
    [storeToVault, compressMessages, compressWithHeadroom, injectCaveman, injectPonytail, dedupeTools]
      .forEach((mock) => mock.mockClear());

    await handleChatCore({
      body,
      sourceFormatOverride: "claude",
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { accessToken: "token" },
      clientRawRequest: {
        endpoint: "/v1/messages",
        body,
        headers: { "user-agent": "claude-cli/2.1.320 (external, cli)", accept: "text/event-stream" },
      },
      connectionId: "test-connection",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      vaultEnabled: true,
      vaultConversationId: "scope",
      rtkEnabled: true,
      headroomEnabled: true,
      cavemanEnabled: true,
      cavemanLevel: "full",
      ponytailEnabled: true,
      ponytailLevel: "full",
      pxpipeEnabled: true,
    });

    const dispatched = executeMock.mock.calls[0][0].body;
    expect(dispatched.safeguards).toEqual({ opaque: "preserve" });
    expect(storeToVault).not.toHaveBeenCalled();
    expect(dedupeTools).not.toHaveBeenCalled();
    expect(compressMessages.mock.calls[0][1]).toBe(false);
    expect(compressWithHeadroom.mock.calls[0][1].enabled).toBe(false);
    expect(injectCaveman).not.toHaveBeenCalled();
    expect(injectPonytail).not.toHaveBeenCalled();
  });
});
