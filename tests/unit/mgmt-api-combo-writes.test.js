import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCombo: vi.fn(),
  deleteCombo: vi.fn(),
  deleteRoutingDataForCombo: vi.fn(),
  getComboById: vi.fn(),
  getComboByName: vi.fn(),
  getCombos: vi.fn(),
  getSettings: vi.fn(),
  rekeyRoutingDataForCombo: vi.fn(),
  updateCombo: vi.fn(),
  updateSettings: vi.fn(),
  validateApiKey: vi.fn(),
  hasValidCliToken: vi.fn(),
  resetComboRotation: vi.fn(),
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
  createCombo: mocks.createCombo,
  deleteCombo: mocks.deleteCombo,
  deleteRoutingDataForCombo: mocks.deleteRoutingDataForCombo,
  getComboById: mocks.getComboById,
  getComboByName: mocks.getComboByName,
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
  rekeyRoutingDataForCombo: mocks.rekeyRoutingDataForCombo,
  updateCombo: mocks.updateCombo,
  updateSettings: mocks.updateSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: mocks.resetComboRotation }));

const combosRoute = await import("../../src/app/api/mgmt/v1/combos/route.js");
const comboByIdRoute = await import("../../src/app/api/mgmt/v1/combos/[id]/route.js");
const strategyRoute = await import("../../src/app/api/mgmt/v1/combos/[id]/strategy/route.js");

function request(url, body, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", host: "localhost:20128" },
    body: JSON.stringify(body),
  });
}

describe("management API combo writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    delete process.env.MANAGEMENT_TOKEN;
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getComboByName.mockResolvedValue(null);
    mocks.getComboById.mockResolvedValue({ id: "combo-1", name: "auto-combo" });
    mocks.getCombos.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue({ comboStrategies: {} });
    mocks.updateSettings.mockResolvedValue(undefined);
  });

  it("returns the required validation message for an invalid create name", async () => {
    const response = await combosRoute.POST(request("http://localhost:20128/api/mgmt/v1/combos", {
      name: "bad name!",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Name can only contain letters, numbers, -, _ and .");
  });

  it("returns the required validation message for a duplicate create name", async () => {
    mocks.getComboByName.mockResolvedValue({ id: "existing-combo", name: "duplicate" });
    const response = await combosRoute.POST(request("http://localhost:20128/api/mgmt/v1/combos", {
      name: "duplicate",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Combo name already exists");
  });

  it("rejects Auto strategy without a router model", async () => {
    const response = await strategyRoute.PUT(
      request("http://localhost:20128/api/mgmt/v1/combos/combo-1/strategy", { fallbackStrategy: "auto" }),
      { params: Promise.resolve({ id: "combo-1" }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toMatch(/Auto combo .* requires a router model/);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("persists a valid Auto strategy with a router model", async () => {
    const strategy = { fallbackStrategy: "auto", routerModel: "claude-haiku" };
    const response = await strategyRoute.PUT(
      request("http://localhost:20128/api/mgmt/v1/combos/combo-1/strategy", strategy),
      { params: Promise.resolve({ id: "combo-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ v: 1, data: { combo: "auto-combo", strategy } });
    expect(mocks.updateSettings).toHaveBeenCalledWith({ comboStrategies: { "auto-combo": strategy } });
  });

  it("drops unknown combo fields on update (no mass assignment)", async () => {
    mocks.updateCombo.mockImplementation(async (id, data) => ({
      id, name: "auto-combo", kind: null, models: [], ...data,
    }));

    const response = await comboByIdRoute.PUT(
      request(
        "http://localhost:20128/api/mgmt/v1/combos/combo-1",
        { name: "renamed-combo", id: "evil-id", isAdmin: true, createdAt: "1999-01-01" },
        "PUT",
      ),
      { params: Promise.resolve({ id: "combo-1" }) },
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    // The repo is only ever called with the allowlisted fields...
    expect(mocks.updateCombo).toHaveBeenCalledWith("combo-1", { name: "renamed-combo" });
    // ...so neither the persisted record nor the response can carry injected keys.
    expect(serialized).not.toContain("isAdmin");
    expect(serialized).not.toContain("evil-id");
    expect(serialized).not.toContain("1999-01-01");
  });

  it("drops unknown strategy keys on strategy update", async () => {
    const response = await strategyRoute.PUT(
      request(
        "http://localhost:20128/api/mgmt/v1/combos/combo-1/strategy",
        {
          fallbackStrategy: "fallback",
          capacityAutoSwitch: true,
          filterWorker: "() => true",
          __proto__polluted: true,
          evilKey: "x",
          autoTuning: { maxFewShots: 3, evilNested: "y" },
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: "combo-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.strategy).toEqual({
      fallbackStrategy: "fallback",
      capacityAutoSwitch: true,
      autoTuning: { maxFewShots: 3 },
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      comboStrategies: {
        "auto-combo": {
          fallbackStrategy: "fallback",
          capacityAutoSwitch: true,
          autoTuning: { maxFewShots: 3 },
        },
      },
    });
  });

  it("fails closed (503) when a member lookup errors during cycle validation", async () => {
    // Name itself is available, but resolving the nested member throws — we must
    // refuse rather than treat the unresolved member as a leaf and risk a cycle.
    mocks.getComboByName.mockImplementation(async (name) => {
      if (name === "nested-x") throw new Error("db read failed");
      return null;
    });
    const response = await combosRoute.POST(request("http://localhost:20128/api/mgmt/v1/combos", {
      name: "parent-combo",
      models: ["nested-x"],
    }));

    expect(response.status).toBe(503);
    expect(mocks.createCombo).not.toHaveBeenCalled();
  });

  it("rejects a non-object strategy body", async () => {
    const response = await strategyRoute.PUT(
      request("http://localhost:20128/api/mgmt/v1/combos/combo-1/strategy", ["auto"], "PUT"),
      { params: Promise.resolve({ id: "combo-1" }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Strategy must be a JSON object");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
