// Cline free models (z-ai/glm-5.3-flash, deepseek-v4-flash) wrap non-stream
// chat completions in {"success":true,"data":{...choices...}} on
// https://api.cline.bot/api/v1/chat/completions. Both the UI model-test ping
// (src/app/api/models/test/ping.js) and the proxy non-stream path
// (open-sse/handlers/chatCore/nonStreamingHandler.js) read `choices` at the
// top level, so enveloped choices are invisible ("Provider returned no
// completion choices for this model"). These tests pin the unwrap behavior.
//
// Adapted from upstream 122f23ee: usage logging goes through runtimeDeps here
// (not @/lib/usageDb) and the Cline catalog fetch rides proxyAwareFetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/cliToken", async () => {
  const actual = await vi.importActual("@/shared/utils/cliToken");
  return { ...actual, getCliToken: vi.fn(async () => "cli-token"), CLI_TOKEN_HEADER: actual.CLI_TOKEN_HEADER };
});
// requestDetail.js funnels usage/detail saves through runtimeDeps; one mock
// covers the handler and its usage helpers.
vi.mock("../../open-sse/runtimeDeps.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
// Our tree routes the catalog request through proxyAwareFetch (SSRF/proxy
// plumbing); stubbed per-test in the aggregation suite below.
const proxyFetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
const aggregationFetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchMock,
}));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { saveRequestUsage } = await import("../../open-sse/runtimeDeps.js");
const { resolveClineModels, resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");

describe("cline free-models {success,data} envelope (ping)", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(obj) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(obj),
      json: async () => obj,
    };
  }

  it("ping: enveloped success unwraps to ok:true (regression for reported error)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { choices: [{ message: { content: "OK" } }] } })
    );
    const result = await pingModelByKind("cl/z-ai/glm-5.3-flash", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(true);
  });

  it("ping: error envelope passes through without unwrap", async () => {
    const body = { error: "empty response content", success: false };
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    const result = await pingModelByKind("cl/z-ai/glm-5.3-flash", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty response content/);
  });

  it("ping: bare (un-enveloped) body still passes", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: "Hello!" } }] }));
    const result = await pingModelByKind("cl/z-ai/glm-5.3-flash", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(true);
  });

  it("ping: does not unwrap for a provider that did not opt in", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { choices: [{ message: { content: "OK" } }] } })
    );
    const result = await pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no completion choices/i);
  });
});

describe("cline free-models envelope in nonStreamingHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function callHandler(providerResponse, provider = "cline") {
    return handleNonStreamingResponse({
      providerResponse,
      provider,
      model: "z-ai/glm-5.3-flash",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "c1",
      clientKeyId: "k1",
      clientRawRequest: null,
      onRequestSuccess: () => {},
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
      toolNameMap: null,
      trackDone: () => {},
      appendLog: () => {},
      pxpipe: null,
      streamSignal: null,
    });
  }

  it("unwraps the {success,data} envelope before usage extraction and translation", async () => {
    const providerResponse = new Response(
      JSON.stringify({
        success: true,
        data: {
          choices: [{ message: { content: "Hi" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const result = await callHandler(providerResponse);
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.choices).toBeDefined();
    expect(body.choices[0].message.content).toBe("Hi");
    expect(body.success).toBeUndefined();
    // The unwrap must precede usage extraction — the recorded usage is the
    // inner data.usage, not the (absent) top-level usage.
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
    });
    // Our tree bills accurate usage by default (CLIENT_USAGE_BUFFER_TOKENS=0),
    // so the client-visible usage equals the inner data.usage.
    expect(body.usage.prompt_tokens).toBe(5);
  });

  it("passes a bare (non-enveloped) body through unchanged", async () => {
    const providerResponse = new Response(
      JSON.stringify({
        choices: [{ message: { content: "Hi" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const result = await callHandler(providerResponse);
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.choices[0].message.content).toBe("Hi");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 1,
    });
    expect(body.usage.prompt_tokens).toBe(3);
  });

  // The unwrap is opt-in via transport.quirks.clineEnvelope so it can never
  // rewrite another provider's body — including one that happens to return
  // {"success":true,data:...} for its own reasons.
  it("leaves an enveloped body untouched for a provider that did not opt in", async () => {
    const providerResponse = new Response(
      JSON.stringify({
        success: true,
        data: { choices: [{ message: { content: "Hi" } }] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const result = await callHandler(providerResponse, "openai");
    const body = await result.response.json();
    expect(body.success).toBe(true);
    expect(body.data.choices[0].message.content).toBe("Hi");
    expect(body.choices).toBeUndefined();
  });
});

describe("cline /api/v1/models aggregation (resolveClineModels vs resolveClinepassModels)", () => {
  const fetchMock = aggregationFetchMock;

  const API_RESPONSE = [
    { id: "cline-pass/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "cline-pass/glm-5.2", name: "GLM-5.2" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "z-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash (Free)" },
  ];

  beforeEach(() => {
    proxyFetchMock.mockReset().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolveClineModels returns all models (including free-tier)", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => API_RESPONSE,
    });
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result).not.toBeNull();
    expect(result.models).toHaveLength(4);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("cline-pass/deepseek-v4-flash");
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("z-ai/deepseek-v4-flash");
  });

  it("resolveClinepassModels returns only cline-pass/ models", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => API_RESPONSE,
    });
    const result = await resolveClinepassModels({ accessToken: "test-token" });
    expect(result).not.toBeNull();
    expect(result.models).toHaveLength(2);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("cline-pass/deepseek-v4-flash");
    expect(ids).toContain("cline-pass/glm-5.2");
    expect(ids).not.toContain("z-ai/glm-5.3-flash");
  });

  it("resolveClineModels unwraps {success,data} envelope from the catalog", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: API_RESPONSE }),
    });
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result).not.toBeNull();
    expect(result.models).toHaveLength(4);
  });

  it("merges the recommended-models free[] tier into the catalog", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => API_RESPONSE,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ free: [{ id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (Free)" }] }),
    });
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result.models).toHaveLength(5);
    expect(result.models.map((m) => m.id)).toContain("cline-free/deepseek-v4.1-flash");
  });

  it("resolveClineModels returns null when no token", async () => {
    const result = await resolveClineModels({});
    expect(result).toBeNull();
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it("resolveClineModels returns null on fetch error", async () => {
    proxyFetchMock.mockRejectedValue(new Error("network error"));
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result).toBeNull();
  });

  it("resolveClineModels returns {id,name} shape", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => API_RESPONSE,
    });
    const result = await resolveClineModels({ accessToken: "test-token" });
    expect(result.models[0]).toHaveProperty("id");
    expect(result.models[0]).toHaveProperty("name");
    expect(typeof result.models[0].id).toBe("string");
    expect(typeof result.models[0].name).toBe("string");
  });

  it("sends the catalog request through proxyAwareFetch with clinepass identity", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: async () => API_RESPONSE,
    });
    await resolveClineModels({ apiKey: "test-key" });
    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = proxyFetchMock.mock.calls[0];
    expect(url).toBe("https://api.cline.bot/api/v1/models");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.identity).toBeDefined();
  });
});
