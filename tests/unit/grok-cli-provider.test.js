import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(() => false),
}));

vi.mock("../../open-sse/config/providers.js", () => ({
  PROVIDER_OAUTH: {},
  PROVIDERS: {
    "grok-cli": {
      identity: "grok-build",
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      format: "openai-responses",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      refreshUrl: "https://auth.x.ai/oauth2/token",
    },
  },
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { refreshProviderCredentials } from "../../open-sse/services/oauthCredentialManager.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";
import {
  mapGrokCliTokens,
  pollGrokCliToken,
  requestGrokCliDeviceCode,
} from "../../src/lib/oauth/grokCli.js";
import { parseGrokCliBilling, getGrokCliUsage } from "../../open-sse/services/usage/grok-cli.js";
import { parseGrokCliModels, resolveGrokCliModels } from "../../open-sse/services/grokCliModels.js";
import grokCliProvider from "../../open-sse/providers/registry/grok-cli.js";
import { refreshAccessToken } from "../../open-sse/services/tokenRefresh/providers.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("grok-cli provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("declares the distinct Responses transport and device OAuth", () => {
    expect(grokCliProvider.id).toBe("grok-cli");
    expect(grokCliProvider.transport).toMatchObject({
      baseUrl: "https://cli-chat-proxy.grok.com/v1/responses",
      format: "openai-responses",
      identity: "grok-build",
      forceStream: true,
    });
    expect(grokCliProvider.oauth).toMatchObject({
      deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
  });

  it("uses request-local Grok headers and corrected request shape", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const executor = new GrokCliExecutor();
    await executor.execute({
      model: "grok-4.5-high",
      body: {
        model: "grok-4.5-high",
        input: "hello",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "must be removed" }],
      },
      stream: true,
      credentials: {
        accessToken: "token",
        connectionId: "connection-1",
        providerSpecificData: { email: "u@example.com", userId: "user-1", deviceId: "agent-1" },
      },
    });

    const [url, options] = proxyAwareFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(options.identity).toBe("grok-build");
    expect(options.provider).toBe("grok-cli");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer token",
      "x-grok-agent-id": "agent-1",
      "x-grok-model-override": "grok-4.5",
      "x-grok-turn-idx": "1",
      "x-email": "u@example.com",
      "x-userid": "user-1",
    });
    expect(options.headers["x-grok-session-id"]).toBeTruthy();
    expect(options.headers["x-grok-conv-id"]).toBe(options.headers["x-grok-session-id"]);
    expect(options.headers["x-grok-req-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ model: "grok-4.5", stream: true, store: false });
    expect(body.messages).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  it("normalizes function, custom, and built-in tools with a forced choice", () => {
    const body = new GrokCliExecutor().transformRequest("grok-build", {
      input: "use a tool",
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look something up",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
        { type: "custom", name: "shell", description: "Run a command" },
        { type: "web_search", search_context_size: "low" },
      ],
      tool_choice: { type: "custom", name: "shell" },
    }, true, { connectionId: "connection-1" });

    expect(body.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Look something up",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      {
        type: "function",
        name: "shell",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
      { type: "web_search", search_context_size: "low" },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "shell" });
  });

  it("preserves native Grok item ids while stripping non-native server ids", () => {
    const executor = new GrokCliExecutor();
    const nativeId = "rs_3e3f6187-892a-96db-893b-904eff019e19";
    const body = executor.transformRequest("grok-4.5", {
      input: [
        { type: "reasoning", id: nativeId, encrypted_content: "cipher" },
        { type: "message", id: "msg_server_id", role: "assistant", content: "done" },
        { type: "message", role: "user", content: "next" },
      ],
    }, true, { connectionId: "connection-1" });
    expect(body.input[0].id).toBe(nativeId);
    expect(body.input[1].id).toBeUndefined();
  });

  it("runs device OAuth requests through the Grok Build identity", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ device_code: "dev", user_code: "ABCD" }))
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400));

    await requestGrokCliDeviceCode(grokCliProvider.oauth);
    const pending = await pollGrokCliToken(grokCliProvider.oauth, "dev");

    expect(pending).toEqual({ ok: true, data: { error: "authorization_pending" } });
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options).toMatchObject({ identity: "grok-build", provider: "grok-cli" });
    }
    expect(mapGrokCliTokens({ access_token: "a", refresh_token: "r", expires_in: 3600 }, {
      user: { email: "u@example.com", userId: "user-1" },
    })).toMatchObject({
      accessToken: "a",
      refreshToken: "r",
      email: "u@example.com",
      providerSpecificData: { authMethod: "device_code", userId: "user-1" },
    });
  });

  it("refreshes as the public Grok Build client without a fake secret", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({ access_token: "new", expires_in: 3600 }));
    await refreshAccessToken("grok-cli", "refresh", {}, console);
    const [, options] = proxyAwareFetch.mock.calls[0];
    expect(options).toMatchObject({ identity: "grok-build", provider: "grok-cli", format: "openai-responses" });
    expect(options.body.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(options.body.has("client_secret")).toBe(false);
  });

  it("fetches live models and usage with the same identity", async () => {
    expect(parseGrokCliModels({ models: [{ model_id: "grok-build", display_name: "Grok Build" }] }))
      .toEqual([expect.objectContaining({ id: "grok-build", name: "Grok Build" })]);
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "grok-build" }] }))
      .mockResolvedValueOnce(jsonResponse({ config: { onDemandCap: { val: 100 }, onDemandUsed: { val: 25 } } }))
      .mockResolvedValueOnce(jsonResponse({ hasGrokCodeAccess: true }));

    const models = await resolveGrokCliModels({ accessToken: "token" });
    const usage = await getGrokCliUsage("token");

    expect(models.models[0]).toMatchObject({ id: "grok-build", contextLength: 500000 });
    expect(usage.quotas["On-demand"]).toMatchObject({ used: 25, total: 100, remainingPercentage: 75 });
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options).toMatchObject({ identity: "grok-build", provider: "grok-cli" });
    }
  });

  it("keeps the configured proxy when model discovery refreshes credentials", async () => {
    const credentials = { accessToken: "expired", refreshToken: "refresh" };
    const proxyOptions = { proxyUrl: "http://proxy.example:8080" };
    refreshProviderCredentials.mockResolvedValue({ accessToken: "new" });
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "grok-build" }] }));

    const result = await resolveGrokCliModels(credentials, { proxyOptions });

    expect(result.models).toHaveLength(1);
    expect(refreshProviderCredentials).toHaveBeenCalledWith("grok-cli", credentials, console, proxyOptions);
    expect(proxyAwareFetch.mock.calls.every(([, , proxy]) => proxy === proxyOptions)).toBe(true);
  });

  it("bounds the optional user lookup and falls back to billing-only usage", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ config: { onDemandCap: { val: 100 }, onDemandUsed: { val: 25 } } }))
      .mockImplementationOnce((_url, options) => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }));

    const pending = getGrokCliUsage("token");
    await Promise.resolve();
    timeoutController.abort();

    await expect(pending).resolves.toMatchObject({
      plan: "Grok Build",
      quotas: { "On-demand": { used: 25, total: 100 } },
    });
    expect(timeoutSpy).toHaveBeenCalledWith(2_000);
    timeoutSpy.mockRestore();
  });

  it("preserves encrypted reasoning across Responses and chat formats", () => {
    const chat = openaiResponsesToOpenAIRequest("grok-4.5", {
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "cipher" },
        { type: "message", role: "assistant", content: "done" },
      ],
    }, true, {});
    expect(chat.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "plan",
      encrypted_content: "cipher",
    });
    const roundTrip = openaiToOpenAIResponsesRequest("grok-4.5", chat, true, {});
    expect(roundTrip.input[0]).toMatchObject({ type: "reasoning", encrypted_content: "cipher" });
  });

  it("normalizes exhausted billing without calling it unlimited", () => {
    const parsed = parseGrokCliBilling({ config: {
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    } });
    expect(parsed.quotas["On-demand"]).toMatchObject({
      used: 1,
      total: 1,
      remainingPercentage: 0,
      unlimited: false,
    });
  });
});
