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
const strategyRoute = await import("../../src/app/api/mgmt/v1/combos/[id]/strategy/route.js");

function request(url, body) {
  return new Request(url, {
    method: "POST",
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
});
