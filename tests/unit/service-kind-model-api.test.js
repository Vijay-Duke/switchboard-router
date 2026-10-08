import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeImportedModel } from "@/shared/utils/importProviderModels.js";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels.js";
import { prepareProbeModels } from "@/lib/model-probe/prepareModels.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/index.js", () => mocks);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("open-sse/services/providerModels.js", () => ({ resolveProviderModels: vi.fn(async () => null) }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshImportedCursorCredentials: vi.fn(async (connection) => connection),
  updateProviderCredentials: vi.fn(),
}));

const { GET: getChatModels } = await import("@/app/api/v1/models/route.js");
const { GET: getModelsByKind } = await import("@/app/api/v1/models/[kind]/route.js");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([{
    id: "audit-gemini", provider: "gemini", isActive: true, providerSpecificData: {},
  }]);
  mocks.getCustomModels.mockResolvedValue([]);
});

async function listed(kind) {
  const response = kind === "llm"
    ? await getChatModels(new Request("http://localhost/v1/models"))
    : await getModelsByKind(new Request("http://localhost/v1/models/" + kind), { params: Promise.resolve({ kind }) });
  expect(response.status).toBe(200);
  return (await response.json()).data.map((model) => model.id);
}

describe("service kind normalization through model APIs and probe planning", () => {
  it("keeps an imported vision model available in both vision and chat discovery", async () => {
    const imported = normalizeImportedModel({ id: "audit-vision", kind: "imageToText" }, "gemini");
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "gemini", ...imported }]);
    expect(await listed("image-to-text")).toContain("gemini/audit-vision");
    expect(await listed("llm")).toContain("gemini/audit-vision");
  });

  it("recovers vision models previously stored with a lowercased service kind", async () => {
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "gemini", id: "audit-old-vision", type: "imagetotext" }]);
    expect(await listed("image-to-text")).toContain("gemini/audit-old-vision");
  });

  it.each(["webSearch", "webFetch"])("lists imported %s rows in web discovery", async (kind) => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "audit-exa", provider: "exa", isActive: true, providerSpecificData: {} }]);
    const imported = normalizeImportedModel({ id: "audit-web", kind }, "exa");
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "exa", ...imported }]);
    expect(await listed("web")).toContain("exa/audit-web");
  });

  it("keeps imported vision models in the vision picker", () => {
    const imported = normalizeImportedModel({ id: "audit-vision", kind: "imageToText" }, "gemini");
    const rows = getProviderCustomModelRows({
      providerAlias: "gemini", type: "imageToText",
      customModels: [{ providerAlias: "gemini", ...imported }],
    });
    expect(rows.map((row) => row.fullModel)).toEqual(["gemini/audit-vision"]);
  });

  it.each(["imageToText", "webSearch", "webFetch"])("uses existing dead-probe entries for %s models", (kind) => {
    const result = prepareProbeModels({
      models: [{ id: "audit-probe", kind }],
      probes: [{ modelId: "audit-probe", kind, status: "dead" }],
    });
    expect(result.eligible).toEqual([]);
    expect(result.skippedDead).toHaveLength(1);
  });

  it.each([false, true])("keeps the newest result when canonical and legacy probe keys converge (reverse=%s)", (reverse) => {
    const probes = [
      { modelId: "audit-probe", kind: "webSearch", status: "ok", checkedAt: new Date(Date.now() - 1000).toISOString() },
      { modelId: "audit-probe", kind: "websearch", status: "dead", checkedAt: new Date(Date.now() - 60000).toISOString() },
    ];
    const result = prepareProbeModels({
      models: [{ id: "audit-probe", kind: "webSearch" }],
      probes: reverse ? probes.reverse() : probes,
      skipFreshOk: true,
      freshOkMs: 60000,
    });
    expect(result.skippedDead).toEqual([]);
    expect(result.skippedFreshOk).toHaveLength(1);
    expect(result.eligible).toEqual([]);
  });

  it("preserves dead-probe cache hits from previously lowercased service kinds", () => {
    const result = prepareProbeModels({
      models: [{ id: "audit-probe", kind: "webSearch" }],
      probes: [{ modelId: "audit-probe", kind: "websearch", status: "dead" }],
    });
    expect(result.eligible).toEqual([]);
    expect(result.skippedDead).toHaveLength(1);
  });
});
