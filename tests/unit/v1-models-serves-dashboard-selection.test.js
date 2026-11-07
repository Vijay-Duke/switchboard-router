// /v1/models must serve exactly the models a provider's dashboard page lists
// as enabled: live-discovered or imported models are served, removed ones are
// not, and no static registry entry leaks in when the page doesn't show it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  discoverConnectionModels: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("@/lib/providerModelDiscovery", () => ({
  discoverConnectionModels: mocks.discoverConnectionModels,
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

// The live Codex catalog the user's account returned on 7 Nov 2026.
const CODEX_LIVE = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"]
  .flatMap((id) => [{ id }, { id: `${id}-review`, upstreamModelId: id }]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([
    { id: "codex-conn", provider: "codex", isActive: true, accessToken: "t", providerSpecificData: {} },
  ]);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.discoverConnectionModels.mockResolvedValue({ models: CODEX_LIVE });
});

async function cxIds() {
  return (await buildModelsList(["llm"], { skipCompatibleDiscovery: true }))
    .map((m) => m.id)
    .filter((id) => id.startsWith("cx/"));
}

describe("/v1/models serves the provider dashboard selection", () => {
  it("serves a live-discovered model the dashboard lists (cx/gpt-6.1-terra)", async () => {
    expect(await cxIds()).toContain("cx/gpt-6.1-terra");
  });

  it("serves only the models left enabled on the dashboard", async () => {
    // Everything except the four models the user kept is removed on the page.
    const kept = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"]);
    const { PROVIDER_MODELS } = await import("@/shared/constants/models");
    const removed = [...(PROVIDER_MODELS.cx || []), ...CODEX_LIVE]
      .map((m) => m.id)
      .filter((id) => !kept.has(id));
    mocks.getDisabledModels.mockResolvedValue({ cx: removed });

    expect((await cxIds()).sort()).toEqual([
      "cx/gpt-6-astra", "cx/gpt-6-luna", "cx/gpt-6.1-sol", "cx/gpt-6.1-terra",
    ]);
  });

  it("does not turn bare-name aliases into provider models", async () => {
    // Aliases like gpt-4o -> codex/gpt-4o were advertising cx/gpt-4o even
    // though the Codex page never listed it.
    mocks.getModelAliases.mockResolvedValue({ "gpt-4o": "codex/gpt-4o", o3: "codex/o3" });
    const ids = await cxIds();
    expect(ids).not.toContain("cx/gpt-4o");
    expect(ids).not.toContain("cx/o3");
  });

  it("serves a model saved by Import models when discovery is unavailable", async () => {
    mocks.discoverConnectionModels.mockResolvedValue({ error: "down", status: 503 });
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "cx", id: "gpt-6.1-terra", type: "llm" }]);
    expect(await cxIds()).toContain("cx/gpt-6.1-terra");
  });

  it("removes a disabled model even when discovery still returns it", async () => {
    mocks.getDisabledModels.mockResolvedValue({ cx: ["gpt-6.1-terra"] });
    expect(await cxIds()).not.toContain("cx/gpt-6.1-terra");
  });
});

describe("/v1/models kind of live models", () => {
  it("treats untyped live rows as chat models, like the dashboard page", async () => {
    mocks.discoverConnectionModels.mockResolvedValue({
      models: [{ id: "gpt-image-2" }, { id: "gpt-image-3", type: "image" }],
    });
    const ids = await cxIds();
    expect(ids).toContain("cx/gpt-image-2");
    expect(ids).not.toContain("cx/gpt-image-3");
  });
});
