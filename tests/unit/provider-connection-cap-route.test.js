import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/models", () => ({
  ...mocks,
  deleteProviderConnection: vi.fn(),
  redactSecrets: (value) => value,
}));

const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
const call = (value) => PUT(new Request("http://localhost/api/providers/c1", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ maxConcurrentRequests: value }),
}), { params: Promise.resolve({ id: "c1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({
    id: "c1",
    authType: "apikey",
    providerSpecificData: undefined,
  });
  mocks.updateProviderConnection.mockImplementation(async (id, update) => ({ id, ...update }));
});

it.each([null, 1, 1024])("persists valid process-local cap %j", async (value) => {
  const response = await call(value);
  expect(response.status).toBe(200);
  expect(mocks.updateProviderConnection).toHaveBeenCalledWith("c1", {
    maxConcurrentRequests: value,
  });
});

it.each([0, -1, 1.5, "2", 1025])("rejects invalid cap %j", async (value) => {
  const response = await call(value);
  expect(response.status).toBe(400);
  expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
});

it("leaves the connection cap untouched when the field is absent", async () => {
  const response = await PUT(new Request("http://localhost/api/providers/c1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Renamed" }),
  }), { params: Promise.resolve({ id: "c1" }) });
  expect(response.status).toBe(200);
  expect(mocks.updateProviderConnection).toHaveBeenCalledWith("c1", { name: "Renamed" });
});
