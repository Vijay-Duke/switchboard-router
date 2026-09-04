// O22: POST /api/keys with findOrCreate is serialized server-side so two
// concurrent auto-provision calls share one "Default Key".

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  createApiKey: mocks.createApiKey,
  getApiKeys: mocks.getApiKeys,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));

const { POST } = await import("@/app/api/keys/route.js");

const post = (body) => POST(new Request("http://localhost/api/keys", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

let store;

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  mocks.getConsistentMachineId.mockResolvedValue("machine-1");
  // Simulate the real repo: a read, then an insert separated by await ticks.
  mocks.getApiKeys.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 1));
    return store.map((k) => ({ ...k }));
  });
  mocks.createApiKey.mockImplementation(async (name) => {
    await new Promise((r) => setTimeout(r, 1));
    const key = { id: `k${store.length + 1}`, name, keyPrefix: "sk-…" };
    store.push(key);
    return { ...key, key: "sk-full-secret" };
  });
});

describe("POST /api/keys findOrCreate (O22)", () => {
  it("creates exactly one key for two concurrent auto-provision requests", async () => {
    const [a, b] = await Promise.all([
      post({ name: "Default Key", findOrCreate: true }),
      post({ name: "Default Key", findOrCreate: true }),
    ]);
    const [bodyA, bodyB] = [await a.json(), await b.json()];

    expect(mocks.createApiKey).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(1);
    expect(bodyA.id).toBe("k1");
    expect(bodyB.id).toBe("k1");
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });

  it("returns the existing key (200, no secret) when the name already exists", async () => {
    store.push({ id: "k9", name: "Default Key", keyPrefix: "sk-…" });
    const response = await post({ name: "Default Key", findOrCreate: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("k9");
    expect(body).not.toHaveProperty("key");
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("keeps the plain create path unchanged (201 with the secret)", async () => {
    store.push({ id: "k9", name: "Build bot", keyPrefix: "sk-…" });
    const response = await post({ name: "Build bot" });
    expect(response.status).toBe(201);
    expect((await response.json()).key).toBe("sk-full-secret");
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1);
  });
});
