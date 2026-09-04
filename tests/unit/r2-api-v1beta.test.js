import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildModelsList: vi.fn(),
  getDisabledModels: vi.fn(),
  handleChat: vi.fn(),
  failDisabledRead: false,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));
vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {
    gemini: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/shared/utils/providerCustomModels.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    buildCanonicalDisabledModelSet: (...args) => {
      if (mocks.failDisabledRead) throw new Error("sqlite: boom");
      return real.buildCanonicalDisabledModelSet(...args);
    },
  };
});
vi.mock("@/shared/utils/cors.js", () => ({
  corsPreflightResponse: () => new Response(null, { status: 200 }),
}));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({ getSettings: vi.fn() }));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: vi.fn(),
  runWithClientKeyLease: vi.fn(),
}));
vi.mock("@/sse/services/connectionInFlight.js", () => ({ withConnectionInFlight: vi.fn() }));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");
const pathRoute = await import("../../src/app/api/v1beta/models/[...path]/route.js");

describe("GET /v1beta/models disabled filtering (A8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildModelsList.mockResolvedValue([]);
    mocks.failDisabledRead = false;
  });

  it("omits static entries disabled in the dashboard", async () => {
    mocks.getDisabledModels.mockResolvedValue({ gemini: ["gemini-2.0-flash"] });
    const res = await GET(new Request("http://localhost/v1beta/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.models.map((m) => m.name);
    expect(names).not.toContain("models/gemini/gemini-2.0-flash");
    expect(names).toContain("models/gemini/gemini-2.5-pro");
  });

  it("lists everything when nothing is disabled", async () => {
    mocks.getDisabledModels.mockResolvedValue({});
    const res = await GET(new Request("http://localhost/v1beta/models"));
    const body = await res.json();
    const names = body.models.map((m) => m.name);
    expect(names).toContain("models/gemini/gemini-2.0-flash");
  });
});

describe("v1beta 500 envelopes (A9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildModelsList.mockResolvedValue([]);
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.failDisabledRead = false;
  });

  it("GET /v1beta/models 500 uses the generic {message, code} shape", async () => {
    mocks.getDisabledModels.mockResolvedValue({ gemini: ["gemini-2.0-flash"] });
    mocks.failDisabledRead = true;
    const res = await GET(new Request("http://localhost/v1beta/models"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({
      error: { message: "Failed to fetch models", code: 500 },
    });
  });

  it("POST [...path] 500 uses the identical envelope keys with a generic message", async () => {
    const res = await pathRoute.POST(
      new Request("http://localhost/v1beta/models/gemini:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.reject(new Error("sqlite: boom")) },
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    const body = JSON.parse(text);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.message).toBe("Failed to handle Gemini request");
  });
});

describe("convertGeminiToInternal tools (A10)", () => {
  it("maps one function declaration to one OpenAI tool", () => {
    const converted = pathRoute.convertGeminiToInternal(
      {
        systemInstruction: { parts: [{ text: "sys" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "get_weather",
                description: "Get weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            ],
          },
        ],
      },
      "gemini/gemini-2.0-flash",
      false,
    );
    expect(converted.tools).toHaveLength(1);
    expect(converted.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    });
  });

  it("maps functionCall/functionResponse turns to tool_calls and tool messages without empty user turns", () => {
    const converted = pathRoute.convertGeminiToInternal(
      {
        contents: [
          { role: "user", parts: [{ text: "weather?" }] },
          { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }] },
          { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { result: { temp: 3 } } } }] },
        ],
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
      },
      "gemini/gemini-2.0-flash",
      true,
    );
    expect(converted.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const call = converted.messages[1].tool_calls[0];
    expect(call.function).toEqual({ name: "get_weather", arguments: JSON.stringify({ city: "Oslo" }) });
    expect(converted.messages[2].tool_call_id).toBe(call.id);
    expect(converted.messages[2].content).toBe(JSON.stringify({ temp: 3 }));
    expect(converted.tool_choice).toBe("none");
    expect(converted.stream).toBe(true);
  });

  it("omits tools when the Gemini body has none", () => {
    const converted = pathRoute.convertGeminiToInternal(
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      "gemini/gemini-2.0-flash",
      false,
    );
    expect(converted.tools).toBeUndefined();
    expect(converted.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("v1beta model path guard (A11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s on a 3-segment model path instead of routing to the wrong model", async () => {
    const res = await pathRoute.POST(
      new Request("http://localhost/v1beta/models/foo/bar/baz:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["foo", "bar", "baz:generateContent"] }) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { message: "Invalid model path", code: 404 },
    });
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });
});
