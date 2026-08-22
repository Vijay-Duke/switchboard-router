import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
  normalizeClientKeyPatch: vi.fn((value) => value),
  updateApiKey: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  createApiKey: mocks.createApiKey,
  deleteApiKey: mocks.deleteApiKey,
  getApiKeyById: mocks.getApiKeyById,
  getApiKeys: mocks.getApiKeys,
  normalizeClientKeyPatch: mocks.normalizeClientKeyPatch,
  updateApiKey: mocks.updateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));

const collection = await import("@/app/api/keys/route.js");
const detail = await import("@/app/api/keys/[id]/route.js");

const safeKey = {
  id: "client-1", keyPrefix: "sk-safe…", name: "Build bot", machineId: "machine-1",
  isActive: true, createdAt: "2026-08-22T00:00:00.000Z", allowedModels: [], allowedCombos: [],
  expiresAt: null, rateLimitPerMinute: null, concurrencyLimit: null, spendLimitUsd: null, spentUsd: 0,
};

function jsonRequest(body) {
  return new Request("https://router.test/api/keys/client-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConsistentMachineId.mockResolvedValue("machine-1");
  mocks.getApiKeys.mockResolvedValue([safeKey]);
  mocks.getApiKeyById.mockResolvedValue(safeKey);
  mocks.updateApiKey.mockResolvedValue(safeKey);
  mocks.deleteApiKey.mockResolvedValue(true);
  mocks.createApiKey.mockResolvedValue({ ...safeKey, key: "sk-full-secret-once" });
  mocks.normalizeClientKeyPatch.mockImplementation((value) => value);
});

describe("client key routes", () => {
  it("returns safe list/detail records and the create secret once", async () => {
    const listBody = await (await collection.GET()).json();
    expect(listBody.keys).toEqual([safeKey]);
    expect(JSON.stringify(listBody)).not.toContain("sk-full-secret-once");

    const detailBody = await (await detail.GET(null, { params: Promise.resolve({ id: "client-1" }) })).json();
    expect(detailBody.key).toEqual(safeKey);
    expect(detailBody.key).not.toHaveProperty("key");

    const created = await collection.POST(jsonRequest({ name: "Build bot" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(expect.objectContaining({
      key: "sk-full-secret-once", id: "client-1", name: "Build bot",
    }));
  });

  it("passes exactly the strict PUT fields while preserving omission and explicit null clearing", async () => {
    const patch = {
      name: "Renamed",
      isActive: false,
      allowedModels: ["gpt-5"],
      allowedCombos: ["fast"],
      expiresAt: null,
      rateLimitPerMinute: 10,
      concurrencyLimit: null,
      spendLimitUsd: 25,
    };
    mocks.normalizeClientKeyPatch.mockReturnValue(patch);
    const response = await detail.PUT(jsonRequest(patch), { params: Promise.resolve({ id: "client-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.normalizeClientKeyPatch).toHaveBeenCalledWith(patch);
    expect(mocks.updateApiKey).toHaveBeenCalledWith("client-1", patch);

    mocks.normalizeClientKeyPatch.mockReturnValue({ name: "Only name" });
    await detail.PUT(jsonRequest({ name: "Only name" }), { params: Promise.resolve({ id: "client-1" }) });
    expect(mocks.updateApiKey).toHaveBeenLastCalledWith("client-1", { name: "Only name" });
  });

  it("returns bounded validation errors without updating or logging request bodies", async () => {
    mocks.normalizeClientKeyPatch.mockImplementation(() => { throw new Error("unknown client key field: key"); });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await detail.PUT(jsonRequest({ key: "never-log-this-secret" }), {
      params: Promise.resolve({ id: "client-1" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "unknown client key field: key", code: "invalid_client_key_policy" },
    });
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("never-log-this-secret");
    log.mockRestore();
  });

  it("preserves 404 and 500 behavior", async () => {
    mocks.getApiKeyById.mockResolvedValueOnce(null);
    expect((await detail.GET(null, { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    mocks.getApiKeyById.mockResolvedValueOnce(null);
    expect((await detail.PUT(jsonRequest({ name: "x" }), { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);
    mocks.deleteApiKey.mockResolvedValueOnce(false);
    expect((await detail.DELETE(null, { params: Promise.resolve({ id: "missing" }) })).status).toBe(404);

    mocks.getApiKeys.mockRejectedValueOnce(new Error("db failed"));
    expect((await collection.GET()).status).toBe(500);
  });
});
