import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  refreshCredentials: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    execute: mocks.execute,
    refreshCredentials: mocks.refreshCredentials,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  refreshProviderCredentials,
  withCredentialRefreshLock,
} from "../../open-sse/services/oauthCredentialManager.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

describe("Grok CLI credential refresh proxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("propagates proxy options through the shared refresh stack", async () => {
    const proxyOptions = { proxyUrl: "http://proxy.example:8080" };
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await refreshProviderCredentials("grok-cli", {
      connectionId: "grok-proxy-test",
      refreshToken: "old-refresh",
    }, null, proxyOptions);

    expect(result).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/token",
      expect.objectContaining({ identity: "grok-build", provider: "grok-cli" }),
      proxyOptions,
    );
  });

  it("passes the connection proxy into reactive chat credential refresh", async () => {
    const credentials = {
      accessToken: "expired",
      refreshToken: "refresh",
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.example:8080",
      },
    };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = (response) => ({
      response,
      url: "https://cli-chat-proxy.grok.com/v1/responses",
      headers: {},
      transformedBody: {},
    });
    mocks.execute
      .mockResolvedValueOnce(result(new Response("unauthorized", { status: 401 })))
      .mockResolvedValueOnce(result(Response.json({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [],
      })));
    mocks.refreshCredentials.mockResolvedValue({ accessToken: "new-access" });

    await handleChatCore({
      body: { model: "grok-build", input: "hello", stream: false },
      modelInfo: { provider: "grok-cli", model: "grok-build" },
      credentials,
      log,
      connectionId: "grok-proxy-test",
      sourceFormatOverride: "openai-responses",
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(mocks.refreshCredentials).toHaveBeenCalledWith(credentials, log, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
    });
  });

  it("completes reactive refresh inside the handler-owned lock", async () => {
    const credentials = { connectionId: "grok-reactive", refreshToken: "reactive-old-refresh" };
    const proxyOptions = { connectionProxyUrl: "http://proxy.example:8080" };
    proxyAwareFetch.mockResolvedValue(Response.json({
      access_token: "reactive-access",
      refresh_token: "reactive-refresh",
      expires_in: 3600,
    }));

    const refreshed = await withCredentialRefreshLock("grok-cli", credentials, () => (
      new GrokCliExecutor().refreshCredentials(credentials, null, proxyOptions)
    ));

    expect(refreshed).toMatchObject({
      accessToken: "reactive-access",
      refreshToken: "reactive-refresh",
    });
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });
});
