import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getComboById: vi.fn(),
  createComboWrite: vi.fn(),
  updateComboWrite: vi.fn(),
  deleteComboWrite: vi.fn(),
  getApiKeyById: vi.fn(),
  deleteApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  normalizeClientKeyPatch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
  redactSecrets: vi.fn(),
  getProviderNodeById: vi.fn(),
  updateProviderNode: vi.fn(),
  deleteProviderConnectionsByProvider: vi.fn(),
  getProviderConnections: vi.fn(),
  deleteProviderNode: vi.fn(),
  getModelAliases: vi.fn(),
  setModelAlias: vi.fn(),
  getDisabledModels: vi.fn(),
  getCapabilitiesForModel: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getComboById: mocks.getComboById,
  deleteApiKey: mocks.deleteApiKey,
  getApiKeyById: mocks.getApiKeyById,
  normalizeClientKeyPatch: mocks.normalizeClientKeyPatch,
  updateApiKey: mocks.updateApiKey,
}));
vi.mock("@/lib/combos/comboWrites.js", () => ({
  ComboWriteError: class ComboWriteError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  },
  createComboWrite: mocks.createComboWrite,
  updateComboWrite: mocks.updateComboWrite,
  deleteComboWrite: mocks.deleteComboWrite,
}));
vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
  redactSecrets: mocks.redactSecrets,
  getProviderNodeById: mocks.getProviderNodeById,
  updateProviderNode: mocks.updateProviderNode,
  deleteProviderConnectionsByProvider: mocks.deleteProviderConnectionsByProvider,
  getProviderConnections: mocks.getProviderConnections,
  deleteProviderNode: mocks.deleteProviderNode,
  getModelAliases: mocks.getModelAliases,
  setModelAlias: mocks.setModelAlias,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: mocks.getCapabilitiesForModel,
}));

const combosById = await import("../../src/app/api/combos/[id]/route.js");
const keysById = await import("../../src/app/api/keys/[id]/route.js");
const providersById = await import("../../src/app/api/providers/[id]/route.js");
const providerNodesById = await import("../../src/app/api/provider-nodes/[id]/route.js");
const modelsRoute = await import("../../src/app/api/models/route.js");
const translatorSave = await import("../../src/app/api/translator/save/route.js");

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const readSrc = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

describe("force-dynamic on DB-backed [id] routes (A15)", () => {
  it.each([
    "src/app/api/combos/[id]/route.js",
    "src/app/api/keys/[id]/route.js",
    "src/app/api/providers/[id]/route.js",
    "src/app/api/provider-nodes/[id]/route.js",
  ])("%s exports force-dynamic", (rel) => {
    expect(readSrc(rel)).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("dashboard DELETE envelopes (A16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("combos DELETE returns {success:true}", async () => {
    mocks.deleteComboWrite.mockResolvedValue(true);
    const res = await combosById.DELETE(
      new Request("http://localhost:20128/api/combos/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("keys DELETE returns {success:true} (message kept for compat)", async () => {
    mocks.deleteApiKey.mockResolvedValue(true);
    const res = await keysById.DELETE(
      new Request("http://localhost:20128/api/keys/k1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "k1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.message).toBe("string");
  });

  it("providers DELETE returns {success:true} (message kept for compat)", async () => {
    mocks.deleteProviderConnection.mockResolvedValue(true);
    const res = await providersById.DELETE(
      new Request("http://localhost:20128/api/providers/p1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.message).toBe("string");
  });

  it("provider-nodes DELETE returns {success:true}", async () => {
    mocks.getProviderNodeById.mockResolvedValue({ id: "n1" });
    mocks.deleteProviderConnectionsByProvider.mockResolvedValue(undefined);
    mocks.deleteProviderNode.mockResolvedValue(true);
    const res = await providerNodesById.DELETE(
      new Request("http://localhost:20128/api/provider-nodes/n1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "n1" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});

describe("PUT /api/models alias guards (A18)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelAliases.mockResolvedValue({});
  });

  function put(body, raw = false) {
    return new Request("http://localhost:20128/api/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });
  }

  it("returns 400 for malformed JSON", async () => {
    const res = await modelsRoute.PUT(put("not-json", true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mocks.setModelAlias).not.toHaveBeenCalled();
  });

  it("returns 400 for non-string model/alias", async () => {
    const res = await modelsRoute.PUT(put({ model: {}, alias: [] }));
    expect(res.status).toBe(400);
    expect(mocks.setModelAlias).not.toHaveBeenCalled();
  });

  it("still saves a valid alias", async () => {
    mocks.setModelAlias.mockResolvedValue(undefined);
    const res = await modelsRoute.PUT(put({ model: "openai/gpt-4o", alias: "gpt4" }));
    expect(res.status).toBe(200);
    expect(mocks.setModelAlias).toHaveBeenCalledWith("openai/gpt-4o", "gpt4");
  });
});

describe("POST /api/translator/save guards (A25)", () => {
  it("returns 400 for malformed JSON", async () => {
    const res = await translatorSave.POST(
      new Request("http://localhost:20128/api/translator/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "Invalid JSON body" });
  });

  it("returns 400 for non-string content", async () => {
    const res = await translatorSave.POST(
      new Request("http://localhost:20128/api/translator/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "1_req_client.json", content: { nested: true } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "Content must be a string" });
  });
});
