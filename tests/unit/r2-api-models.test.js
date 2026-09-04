import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  updateProviderCredentials: vi.fn(),
  refreshImportedCursorCredentials: vi.fn(),
  isClaudeFullCatalogRequest: vi.fn(),
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

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  refreshImportedCursorCredentials: mocks.refreshImportedCursorCredentials,
}));
vi.mock("@/shared/claudeGateway.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isClaudeFullCatalogRequest: mocks.isClaudeFullCatalogRequest,
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");
const kindRoute = await import("../../src/app/api/v1/models/[kind]/route.js");

function get(url) {
  return new Request(url, { headers: { host: "localhost:20128" } });
}

describe("GET /v1/models error/contract (A5/A6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClaudeFullCatalogRequest.mockReturnValue(false);
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
  });

  it("A5: 500 path returns a generic message without driver text", async () => {
    mocks.isClaudeFullCatalogRequest.mockImplementation(() => {
      throw new Error("sqlite: boom");
    });
    const res = await GET(get("http://localhost:20128/v1/models"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({
      error: { message: "Failed to fetch models", type: "server_error" },
    });
  });

  it("A5: DB-down stays fail-open without leaking driver text", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("sqlite: boom"));
    const res = await GET(get("http://localhost:20128/v1/models"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("boom");
  });

  it("A6: every data[] entry carries a numeric created field", async () => {
    const res = await GET(get("http://localhost:20128/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(typeof entry.created).toBe("number");
    }
  });
});

describe("GET /v1/models/[kind] (A7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isClaudeFullCatalogRequest.mockReturnValue(false);
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
  });

  it("500 path returns a generic message without driver text", async () => {
    const res = await kindRoute.GET(get("http://localhost:20128/v1/models/llm"), {
      params: Promise.reject(new Error("sqlite: boom")),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({
      error: { message: "Failed to fetch models", type: "server_error" },
    });
  });

  it("unknown kind still 404s with a stable message", async () => {
    const res = await kindRoute.GET(get("http://localhost:20128/v1/models/nope"), {
      params: Promise.resolve({ kind: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});
