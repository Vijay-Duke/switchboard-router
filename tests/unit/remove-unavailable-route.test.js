import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteCustomModel = vi.fn(async () => {});
const getModelIdsByStatus = vi.fn(async () => ["retry-model"]);

vi.mock("@/lib/db/index.js", () => ({
  deleteCustomModel,
  getCustomModels: vi.fn(async () => [
    { providerAlias: "lite-llm", id: "retry-model", kind: "llm", name: "Retry model" },
    { providerAlias: "lite-llm", id: "working-model", kind: "llm", name: "Working model" },
    { providerAlias: "other", id: "retry-model", kind: "llm", name: "Other provider model" },
  ]),
  getModelIdsByStatus,
  getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "openai-compatible-responses" })),
}));

vi.mock("@/lib/model-probe/index.js", () => ({
  buildModelProbeScopeKey: vi.fn(() => "scope-key"),
  canonicalModelId: vi.fn((id) => id),
}));

vi.mock("open-sse/config/providerModels.js", () => ({
  PROVIDER_ID_TO_ALIAS: { "openai-compatible-responses": "lite-llm" },
}));

const { POST } = await import("../../src/app/api/providers/[id]/model-probes/remove-unavailable/route.js");
const params = Promise.resolve({ id: "c1" });
const req = (body) => ({ json: async () => body });

describe("remove unavailable models route", () => {
  beforeEach(() => {
    deleteCustomModel.mockClear();
    getModelIdsByStatus.mockClear();
  });

  it("removes retryable models only for the selected provider", async () => {
    const response = await POST(req({ status: "retryable", kind: "llm" }), { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(getModelIdsByStatus).toHaveBeenCalledWith(
      "openai-compatible-responses",
      "scope-key",
      "retryable",
      "llm",
      { excludeFailureClasses: ["auth"] },
    );
    expect(deleteCustomModel).toHaveBeenCalledOnce();
    expect(deleteCustomModel).toHaveBeenCalledWith({ providerAlias: "lite-llm", id: "retry-model", type: "llm" });
    expect(data).toMatchObject({ status: "retryable", removed: 1 });
  });

  it("keeps dead removal backward compatible when status is omitted", async () => {
    const response = await POST(req({ kind: "llm" }), { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(getModelIdsByStatus).toHaveBeenCalledWith(
      "openai-compatible-responses",
      "scope-key",
      "dead",
      "llm",
      { excludeFailureClasses: [] },
    );
    expect(data.status).toBe("dead");
  });

  it("rejects unsupported probe statuses", async () => {
    const response = await POST(req({ status: "ok" }), { params });
    expect(response.status).toBe(400);
    expect(getModelIdsByStatus).not.toHaveBeenCalled();
    expect(deleteCustomModel).not.toHaveBeenCalled();
  });
});
