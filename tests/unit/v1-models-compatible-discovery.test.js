import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshImportedCursorCredentials: vi.fn(async (connection) => connection),
  updateProviderCredentials: vi.fn(),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  mocks.getProviderConnections.mockResolvedValue([{
    id: "compatible-connection",
    provider: "openai-compatible-responses-5f69ccc9-f1e2-4faa-acf6-d5551eab7cce",
    apiKey: "secret",
    isActive: true,
    providerSpecificData: {
      baseUrl: "https://litellm.example/v1",
      prefix: "lite-llm",
    },
  }]);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("/v1/models compatible-provider discovery", () => {
  it("discovers models for UUID-backed custom providers and preserves nested IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "openai/gpt-5.6-sol" },
        { id: "vertex_ai/gemini-3.1-flash-lite" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    global.fetch = fetchMock;

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"]);

    expect(models.map((model) => model.id)).toEqual([
      "lite-llm/openai/gpt-5.6-sol",
      "lite-llm/vertex_ai/gemini-3.1-flash-lite",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "X-Switchboard-Model-Catalog": "1",
        }),
      }),
    );
  });

  it("replaces a stale enabled-model snapshot with the current live catalog", async () => {
    mocks.getProviderConnections.mockResolvedValueOnce([{
      id: "compatible-connection",
      provider: "openai-compatible-responses-5f69ccc9-f1e2-4faa-acf6-d5551eab7cce",
      apiKey: "secret",
      isActive: true,
      providerSpecificData: {
        baseUrl: "https://litellm.example/v1",
        prefix: "lite-llm",
        enabledModels: ["openai/gpt-5.5"],
      },
    }]);
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "openai/gpt-5.6-sol" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"]);

    expect(models.map((model) => model.id)).toEqual(["lite-llm/openai/gpt-5.6-sol"]);
  });

  it("suppresses another compatible discovery hop for marked catalog requests", async () => {
    global.fetch = vi.fn();

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://switchboard.test/v1/models", {
      headers: { "X-Switchboard-Model-Catalog": "1" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
