/**
 * QA-024 — GET /v1/models/info must return metadata for models that
 * /v1/models advertises (provider-node prefixed, custom, combos), not just
 * the static PROVIDER_MODELS catalog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelsList: vi.fn() }));

vi.mock("open-sse/config/providerModels.js", () => ({
  PROVIDER_MODELS: {
    openai: [{ id: "gpt-4o", name: "GPT-4o" }],
  },
  getProviderModels: vi.fn(() => []),
  getDefaultModel: vi.fn(() => null),
  isValidModel: vi.fn(() => false),
  findModelName: vi.fn(() => null),
  getModelTargetFormat: vi.fn(() => "openai"),
  getModelStrip: vi.fn(() => false),
  PROVIDER_ID_TO_ALIAS: { openai: "openai" },
  getModelsByProviderId: vi.fn(() => []),
  getModelUpstreamId: vi.fn(() => null),
  getModelQuotaFamily: vi.fn(() => null),
}));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));

const { GET } = await import("../../src/app/api/v1/models/info/route.js");

function getInfo(id, kind) {
  const url = new URL("http://localhost/v1/models/info");
  url.searchParams.set("id", id);
  if (kind) url.searchParams.set("kind", kind);
  return GET(new Request(url, { method: "GET" }));
}

describe("GET /v1/models/info (QA-024)", () => {
  beforeEach(() => {
    mocks.buildModelsList.mockReset();
  });

  it("static catalog hit resolves without consulting the advertised list", async () => {
    const res = await getInfo("openai/gpt-4o");

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.id).toBe("openai/gpt-4o");
    expect(body.kind).toBe("llm");
    expect(body.endpoint).toBe("/v1/chat/completions");
    expect(mocks.buildModelsList).not.toHaveBeenCalled();
  });

  it("returns metadata for a provider-node prefixed advertised model", async () => {
    mocks.buildModelsList.mockResolvedValue([
      { id: "qa-openai/qa-chat", object: "model", owned_by: "qa-openai", capabilities: ["chat"] },
    ]);

    const res = await getInfo("qa-openai/qa-chat");

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.id).toBe("qa-openai/qa-chat");
    expect(body.name).toBe("qa-chat");
    expect(body.kind).toBe("llm");
    expect(body.owned_by).toBe("qa-openai");
    expect(body.endpoint).toBe("/v1/chat/completions");
    expect(body.capabilities).toEqual(["chat"]);
    // Advertised lookup spans all kinds when no ?kind= disambiguator is given.
    const kinds = mocks.buildModelsList.mock.calls[0][0];
    expect(kinds).toContain("llm");
    expect(kinds).toContain("image");
    expect(kinds).toContain("webFetch");
  });

  it("scopes the advertised lookup when ?kind= disambiguates", async () => {
    mocks.buildModelsList.mockResolvedValue([]);

    await getInfo("qa-openai/qa-chat", "llm");

    expect(mocks.buildModelsList.mock.calls[0][0]).toEqual(["llm"]);
  });

  it("unknown id still 404s after the advertised fallback misses", async () => {
    mocks.buildModelsList.mockResolvedValue([
      { id: "qa-openai/qa-chat", object: "model", owned_by: "qa-openai" },
    ]);

    const res = await getInfo("nope/missing");

    expect(res.status).toBe(404);
    const body = JSON.parse(await res.text());
    expect(body.error.type).toBe("not_found");
    expect(body.error.message).toContain("nope/missing");
  });

  it("advertised-list failure degrades to 404 instead of crashing", async () => {
    mocks.buildModelsList.mockRejectedValue(new Error("db down"));

    const res = await getInfo("qa-openai/qa-chat");

    expect(res.status).toBe(404);
  });

  it("missing id is a 400", async () => {
    const res = await GET(new Request("http://localhost/v1/models/info", { method: "GET" }));
    expect(res.status).toBe(400);
  });
});
