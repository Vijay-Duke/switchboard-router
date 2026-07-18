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
  vi.resetAllMocks();
});

describe("/v1/models compatible-provider discovery", () => {
  it("advertises Claude-shaped aliases for Claude Code gateway discovery", async () => {
    mocks.getProviderConnections.mockResolvedValueOnce([]);
    mocks.getModelAliases.mockResolvedValueOnce({
      "claude-switchboard-gpt": "openai/gpt-5.6",
      "anthropic-switchboard-gemini": "gemini/gemini-3.1-pro",
      "my-openai-alias": "openai/gpt-5.6",
    });

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"]);
    const gatewayAliases = models.filter((model) => model.owned_by === "switchboard-alias");

    expect(gatewayAliases).toEqual([
      {
        id: "claude-switchboard-gpt",
        object: "model",
        owned_by: "switchboard-alias",
        display_name: "Switchboard · claude-switchboard-gpt",
      },
      {
        id: "anthropic-switchboard-gemini",
        object: "model",
        owned_by: "switchboard-alias",
        display_name: "Switchboard · anthropic-switchboard-gemini",
      },
    ]);
  });

  it("advertises only the selected LLMs and combos for the full-catalog profile", async () => {
    mocks.getCombos.mockResolvedValueOnce([{
      id: "combo-1",
      name: "coding-auto",
      models: ["lite-llm/openai/gpt-5.6-sol"],
    }]);
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "openai/gpt-5.6-sol" },
        { id: "openai/gpt-5.5-unselected" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const {
      buildClaudeCatalogSelectionHeader,
      CLAUDE_CATALOG_SELECTION_HEADER,
      decodeClaudeCatalogModelId,
    } = await import("../../src/shared/claudeGateway.js");
    const selectedModels = ["lite-llm/openai/gpt-5.6-sol", "coding-auto"];
    const response = await GET(new Request("http://switchboard.test/v1/models?limit=1000", {
      headers: {
        "X-Switchboard-Claude-Mode": "full-catalog",
        [CLAUDE_CATALOG_SELECTION_HEADER]: buildClaudeCatalogSelectionHeader(selectedModels),
      },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.map((model) => decodeClaudeCatalogModelId(model.id))).toEqual(
      expect.arrayContaining(selectedModels),
    );
    expect(body.data).toHaveLength(2);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        owned_by: "switchboard-catalog",
        display_name: "llm | openai | gpt 5.6",
        description: "lite-llm/openai/gpt-5.6-sol",
      }),
      expect.objectContaining({
        owned_by: "switchboard-catalog",
        display_name: "coding-auto",
        description: "coding-auto",
      }),
    ]));
  });

  it("uses saved picker labels for full-catalog discovery when provided", async () => {
    mocks.getProviderConnections.mockResolvedValueOnce([{
      id: "kr-connection",
      provider: "openai-compatible-responses-5f69ccc9-f1e2-4faa-acf6-d5551eab7cce",
      apiKey: "secret",
      isActive: true,
      providerSpecificData: {
        baseUrl: "https://kr.example/v1",
        prefix: "kr",
      },
    }]);
    mocks.getCombos.mockResolvedValueOnce([]);
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "prod/claude-opus-4-8" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const {
      buildClaudeCatalogSelectionHeader,
      CLAUDE_CATALOG_LABELS_HEADER,
      CLAUDE_CATALOG_SELECTION_HEADER,
    } = await import("../../src/shared/claudeGateway.js");
    const selectedModels = ["kr/prod/claude-opus-4-8"];
    const response = await GET(new Request("http://switchboard.test/v1/models", {
      headers: {
        "X-Switchboard-Claude-Mode": "full-catalog",
        [CLAUDE_CATALOG_SELECTION_HEADER]: buildClaudeCatalogSelectionHeader(selectedModels),
        [CLAUDE_CATALOG_LABELS_HEADER]: encodeURIComponent(JSON.stringify({
          "kr/prod/claude-opus-4-8": "KR Opus APAC",
        })),
      },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        display_name: "KR Opus APAC",
        description: "kr/prod/claude-opus-4-8",
      }),
    ]);
  });

  it("publishes no gateway models when the full-catalog selection is empty", async () => {
    mocks.getProviderConnections.mockResolvedValueOnce([]);

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const response = await GET(new Request("http://switchboard.test/v1/models", {
      headers: { "X-Switchboard-Claude-Mode": "full-catalog" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "list", data: [] });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("answers full-catalog discovery without fetching provider catalogs", async () => {
    global.fetch = vi.fn();

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const {
      buildClaudeCatalogSelectionHeader,
      CLAUDE_CATALOG_SELECTION_HEADER,
    } = await import("../../src/shared/claudeGateway.js");
    const selectedModels = [
      "lite-llm/openai/gpt-5.6-terra",
      "kr/claude-opus-4.8-thinking-agentic",
      "coding-auto",
    ];
    const response = await GET(new Request("http://switchboard.test/v1/models?limit=1000", {
      headers: {
        "X-Switchboard-Claude-Mode": "full-catalog",
        [CLAUDE_CATALOG_SELECTION_HEADER]: buildClaudeCatalogSelectionHeader(selectedModels),
      },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(3);
    expect(body.data.map((model) => model.description)).toEqual(selectedModels);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it.each([
    ["image", ["image"]],
    ["tts", ["tts"]],
    ["stt", ["stt"]],
    ["embedding", ["embedding"]],
    ["image-to-text", ["imageToText"]],
    ["web", ["webSearch", "webFetch"]],
  ])("does not advertise Claude gateway aliases in the %s catalog", async (_slug, kindFilter) => {
    mocks.getProviderConnections.mockResolvedValueOnce([]);
    mocks.getModelAliases.mockResolvedValueOnce({
      "claude-switchboard-gpt": "openai/gpt-5.6",
      "anthropic-switchboard-gemini": "gemini/gemini-3.1-pro",
    });

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(kindFilter);

    expect(models).not.toContainEqual(expect.objectContaining({
      owned_by: "switchboard-alias",
    }));
  });

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

  it("keeps probe-removed compatible models out of live discovery", async () => {
    const providerId = "openai-compatible-responses-5f69ccc9-f1e2-4faa-acf6-d5551eab7cce";
    mocks.getDisabledModels.mockResolvedValueOnce({
      [providerId]: ["bedrock/stale-model", "mixedcase/model"],
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "bedrock/stale-model" },
        { id: "models/MixedCase/Model" },
        { id: "bedrock/available-model" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"]);

    expect(models.map((model) => model.id)).toEqual([
      "lite-llm/bedrock/available-model",
    ]);
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
