import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => mocks);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("open-sse/services/providerModels.js", () => ({
  resolveProviderModels: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshImportedCursorCredentials: vi.fn(async (connection) => connection),
  updateProviderCredentials: vi.fn(),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([{
    id: "claude-account", provider: "claude", isActive: true, providerSpecificData: {},
  }]);
  mocks.getCombos.mockResolvedValue([]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});

async function ids() {
  return (await buildModelsList(["llm"], { skipCompatibleDiscovery: true })).map((m) => m.id);
}

describe("model catalog availability", () => {
  it.each(["cc/claude-opus-4-6", "claude/claude-opus-4-6"])(
    "does not advertise a Claude alias targeting disabled %s",
    async (target) => {
      mocks.getModelAliases.mockResolvedValue({ "claude-favorite": target });
      mocks.getDisabledModels.mockResolvedValue({ cc: ["claude-opus-4-6"] });
      const modelIds = await ids();
      expect(modelIds).not.toContain("claude-favorite");
      expect(modelIds).not.toContain("cc/claude-opus-4-6");
    },
  );

  it("uses disabled flags stored under a provider id as well as its public alias", async () => {
    mocks.getDisabledModels.mockResolvedValue({ claude: ["claude/claude-opus-4-6"] });
    expect(await ids()).not.toContain("cc/claude-opus-4-6");
  });

  it("keeps aliases whose targets are enabled", async () => {
    mocks.getModelAliases.mockResolvedValue({ "claude-favorite": "cc/claude-new-version" });
    mocks.getDisabledModels.mockResolvedValue({ cc: ["claude-opus-4-6"] });
    expect(await ids()).toContain("claude-favorite");
  });

  it("does not advertise unconfigured providers when connection lookup succeeds empty", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    expect(await ids()).toEqual([]);
  });

  it("keeps static fallback when connection lookup fails", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("DB unavailable"));
    expect((await ids()).length).toBeGreaterThan(0);
  });

  it("filters disabled custom models during DB-down fallback", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("DB unavailable"));
    mocks.getCustomModels.mockResolvedValue([{
      providerAlias: "cc", id: "claude-future-version", type: "llm",
    }]);
    mocks.getDisabledModels.mockResolvedValue({ cc: ["claude-future-version"] });
    expect(await ids()).not.toContain("cc/claude-future-version");
  });
});
