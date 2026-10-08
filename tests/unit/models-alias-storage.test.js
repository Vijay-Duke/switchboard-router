import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getModelAliases: vi.fn(), setModelAlias: vi.fn(), getDisabledModels: vi.fn(),
}));
vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases, setModelAlias: mocks.setModelAlias,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
const { GET, PUT } = await import("../../src/app/api/models/route.js");
const MODEL = "cc/claude-opus-4-6";
const ALIAS = "claude-favorite";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
  mocks.setModelAlias.mockResolvedValue(undefined);
});
function request(model = MODEL, alias = ALIAS) {
  return new Request("http://localhost/api/models", {
    method: "PUT", body: JSON.stringify({ model, alias }),
  });
}
describe("dashboard models alias storage", () => {
  it("writes aliases in the routing repository alias-to-target direction", async () => {
    expect((await PUT(request())).status).toBe(200);
    expect(mocks.setModelAlias).toHaveBeenCalledWith(ALIAS, MODEL);
  });
  it("reads the existing routing alias for each model", async () => {
    mocks.getModelAliases.mockResolvedValue({ [ALIAS]: MODEL });
    const { models } = await (await GET()).json();
    expect(models.find((m) => m.fullModel === MODEL).alias).toBe(ALIAS);
  });
  it("rejects reuse of an alias assigned to a different model", async () => {
    mocks.getModelAliases.mockResolvedValue({ [ALIAS]: "cc/claude-sonnet-4-6" });
    expect((await PUT(request())).status).toBe(400);
    expect(mocks.setModelAlias).not.toHaveBeenCalled();
  });
  it("allows saving the same alias for the same target", async () => {
    mocks.getModelAliases.mockResolvedValue({ [ALIAS]: MODEL });
    expect((await PUT(request())).status).toBe(200);
    expect(mocks.setModelAlias).toHaveBeenCalledWith(ALIAS, MODEL);
  });
});
