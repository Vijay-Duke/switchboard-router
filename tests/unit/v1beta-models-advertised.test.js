/**
 * QA-026 — GET /v1beta/models (Gemini discovery) must include the active
 * advertised models (local/provider-node connections), not only the static
 * catalog, so generateContent-servable models are discoverable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelsList: vi.fn(), getDisabledModels: vi.fn() }));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));

vi.mock("@/shared/constants/models", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PROVIDER_MODELS: {
      ...actual.PROVIDER_MODELS,
      "audit-vision": [{ id: "vision-chat", name: "Vision Chat", kind: "imageToText" }],
    },
  };
});

const { PROVIDER_MODELS, getModelKind } = await import("@/shared/constants/models");

const { GET } = await import("../../src/app/api/v1beta/models/route.js");

function listModels() {
  return GET(new Request("http://localhost/v1beta/models", { method: "GET" }));
}

describe("GET /v1beta/models Gemini discovery (QA-026)", () => {
  beforeEach(() => {
    mocks.buildModelsList.mockReset();
    mocks.getDisabledModels.mockReset().mockResolvedValue({});
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

  it("does not advertise incompatible static media models as generateContent-capable", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const response = await listModels();
    const names = new Set((await response.json()).models.map((model) => model.name));
    // One model id can have both chat and media entries (e.g. Gemini2.5 STT).
    const chatNames = new Set(Object.entries(PROVIDER_MODELS).flatMap(([provider, models]) =>
      models.filter((model) => ["llm", "imagetotext"].includes(String(getModelKind(model, "llm")).toLowerCase()))
        .map((model) => `models/${provider}/${model.id}`)));
    const nonChatModels = Object.entries(PROVIDER_MODELS).flatMap(([provider, models]) =>
      models.filter((model) => !["llm", "imagetotext"].includes(String(getModelKind(model, "llm")).toLowerCase()))
        .map((model) => `models/${provider}/${model.id}`))
      .filter((name) => !chatNames.has(name));
    expect(nonChatModels.length).toBeGreaterThan(0);
    const nativeGeminiMedia = new Set(PROVIDER_MODELS.gemini
      .filter((model) => ["image", "tts", "stt"].includes(getModelKind(model)))
      .map((model) => `models/gemini/${model.id}`));
    expect(nonChatModels.filter((name) => !nativeGeminiMedia.has(name) && names.has(name))).toEqual([]);
  });

  it("retains enabled Gemini chat models under both bare and provider-prefixed names", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const model = PROVIDER_MODELS.gemini.find((entry) => getModelKind(entry, "llm") === "llm");
    const response = await listModels();
    const { models } = await response.json();
    expect(models).toContainEqual(expect.objectContaining({
      name: `models/gemini/${model.id}`, supportedGenerationMethods: ["generateContent"],
    }));
    expect(models).toContainEqual(expect.objectContaining({
      name: `models/${model.id}`, supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    }));
  });

  it("preserves native Gemini multimodal aliases and methods without listing OpenAI TTS or embeddings", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const { models } = await (await listModels()).json();
    for (const id of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-image", "gemini-2.0-flash"]) {
      expect(models).toContainEqual(expect.objectContaining({
        name: `models/${id}`, supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      }));
      expect(models).toContainEqual(expect.objectContaining({ name: `models/gemini/${id}` }));
    }
    const names = models.map((model) => model.name);
    expect(names).not.toContain("models/openai/tts-1");
    expect(names).not.toContain("models/gemini/gemini-embedding-001");
    expect(names).not.toContain("models/gemini-embedding-001");
  });

  it("keeps chat ids that also have speech metadata in the registry", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const { models } = await (await listModels()).json();
    const names = models.map((model) => model.name);
    expect(names).toContain("models/gemini/gemini-2.5-pro");
    expect(names).toContain("models/gemini-2.5-pro");
  });

  it("keeps vision-understanding models available for chat generation", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const { models } = await (await listModels()).json();
    const names = new Set(models.map((model) => model.name));
    const vision = Object.entries(PROVIDER_MODELS).flatMap(([provider, entries]) =>
      entries.filter((entry) => String(getModelKind(entry)).toLowerCase() === "imagetotext")
        .map((entry) => `models/${provider}/${entry.id}`));
    expect(vision.length).toBeGreaterThan(0);
    expect(vision.every((name) => names.has(name))).toBe(true);
  });

  it("keeps disabled Gemini chat models out of both discovery names", async () => {
    mocks.buildModelsList.mockResolvedValue([]);
    const model = PROVIDER_MODELS.gemini.find((entry) => getModelKind(entry, "llm") === "llm");
    mocks.getDisabledModels.mockResolvedValue({ gemini: [model.id] });
    const response = await listModels();
    const names = (await response.json()).models.map((entry) => entry.name);
    expect(names).not.toContain(`models/gemini/${model.id}`);
    expect(names).not.toContain(`models/${model.id}`);
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
