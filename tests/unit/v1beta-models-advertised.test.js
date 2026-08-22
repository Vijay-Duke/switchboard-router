/**
 * QA-026 — GET /v1beta/models (Gemini discovery) must include the active
 * advertised models (local/provider-node connections), not only the static
 * catalog, so generateContent-servable models are discoverable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelsList: vi.fn() }));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");

function listModels() {
  return GET(new Request("http://localhost/v1beta/models", { method: "GET" }));
}

describe("GET /v1beta/models Gemini discovery (QA-026)", () => {
  beforeEach(() => {
    mocks.buildModelsList.mockReset();
  });

  it("includes active provider-node advertised models the generation endpoint serves", async () => {
    mocks.buildModelsList.mockResolvedValue([
      { id: "qa-openai/qa-chat", object: "model", owned_by: "qa-openai" },
    ]);

    const res = await listModels();

    expect(res.status).toBe(200);
    // LLM filter — generateContent serves chat models, same as /v1/models.
    expect(mocks.buildModelsList.mock.calls[0][0]).toEqual(["llm"]);
    const body = JSON.parse(await res.text());
    const entry = body.models.find((m) => m.name === "models/qa-openai/qa-chat");
    expect(entry).toBeTruthy();
    expect(entry.displayName).toBe("qa-chat");
    expect(entry.supportedGenerationMethods).toContain("generateContent");
  });

  it("keeps the static catalog entries and dedupes overlapping names", async () => {
    mocks.buildModelsList.mockResolvedValue([]);

    const res = await listModels();

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.models.length).toBeGreaterThan(0);
    const names = body.models.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("degrades to the static catalog when advertised-model lookup fails", async () => {
    mocks.buildModelsList.mockRejectedValue(new Error("db down"));

    const res = await listModels();

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((m) => m.name === "models/qa-openai/qa-chat")).toBe(false);
  });
});
