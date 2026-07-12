import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

const FORMATS = {
  OPENAI: "openai",
  OPENAI_RESPONSES: "openai-responses",
};

async function loadRoute(connection) {
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: jsonResponse,
    },
  }));
  vi.doMock("@/lib/jsonError.js", () => ({
    safeErrorMessage: error => error?.message || String(error),
  }));
  vi.doMock("@/sse/services/model.js", () => ({
    getModelInfo: vi.fn(async model => ({ provider: "openai-compatible-responses-crof", model })),
  }));
  vi.doMock("@/lib/db/index.js", () => ({
    getProviderConnections: vi.fn(async () => [connection]),
  }));
  vi.doMock("open-sse/services/provider.js", async () => import("../../open-sse/services/provider.js"));
  vi.doMock("open-sse/translator/formats.js", () => ({ FORMATS }));
  vi.doMock("open-sse/translator/index.js", () => ({
    translateRequest(sourceFormat, targetFormat, model, body) {
      if (targetFormat === FORMATS.OPENAI_RESPONSES) {
        return { input: body.messages?.map(message => message.content) || [] };
      }
      return { messages: body.messages?.map(message => ({ ...message })) || [] };
    },
  }));
  vi.doMock("open-sse/executors/index.js", async () => {
    const { resolveOpenAICompatibleApiType } = await import("../../open-sse/services/provider.js");
    return {
      getExecutor(provider) {
        return {
          buildUrl(model, stream, urlIndex, credentials) {
            if (provider?.startsWith?.("openai-compatible-")) {
              const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://crof.example/v1";
              const path = resolveOpenAICompatibleApiType(provider, credentials) === "responses" ? "/responses" : "/chat/completions";
              return `${baseUrl.replace(/\/$/, "")}${path}`;
            }
            return "https://example.invalid";
          },
          buildHeaders() {
            return { "Content-Type": "application/json" };
          },
          transformRequest(model, translated) {
            return translated;
          },
        };
      },
    };
  });

  return import("../../src/app/api/translator/translate/route.js");
}

function makeRequest(payload) {
  return new Request("http://localhost/api/translator/translate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("translator translate route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/jsonError.js");
    vi.doUnmock("@/sse/services/model.js");
    vi.doUnmock("@/lib/db/index.js");
    vi.doUnmock("open-sse/services/provider.js");
    vi.doUnmock("open-sse/translator/formats.js");
    vi.doUnmock("open-sse/translator/index.js");
    vi.doUnmock("open-sse/executors/index.js");
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps the request body, URL, and metadata on the saved chat transport even when the provider id ends with responses", async () => {
    const connection = {
      isActive: true,
      apiKey: "test-key",
      providerSpecificData: {
        baseUrl: "https://crof.example/v1",
        apiType: "chat",
      },
    };
    const { POST } = await loadRoute(connection);

    const step1Response = await POST(makeRequest({
      step: 1,
      body: {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      },
    }));

    expect(step1Response.status).toBe(200);
    const step1Payload = await step1Response.json();
    expect(step1Payload.success).toBe(true);
    expect(step1Payload.result.targetFormat).toBe("openai");

    const response = await POST(makeRequest({
      step: 3,
      body: {
        provider: "openai-compatible-responses-crof",
        model: "test-model",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      },
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.result.url).toBe("https://crof.example/v1/chat/completions");
    expect(payload.result.body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(payload.result.body.input).toBeUndefined();
  });
});
