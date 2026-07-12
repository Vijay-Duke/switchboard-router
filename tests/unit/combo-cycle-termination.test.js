import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    comboModels: {},
    comboReentries: 0,
    maxReentries: 0,
    settings: {},
  };

  state.getSettings = vi.fn(async () => state.settings);
  state.getComboModels = vi.fn(async (name) => {
    const models = state.comboModels[name];
    return models ? [...models] : null;
  });
  state.getModelInfo = vi.fn(async (name) => {
    if (Object.hasOwn(state.comboModels, name)) {
      state.comboReentries += 1;
      if (state.comboReentries > state.maxReentries) {
        throw new Error(`combo dispatch exceeded ${state.maxReentries} re-entries`);
      }
      return { provider: null, model: name };
    }
    return { provider: "router", model: "x" };
  });

  return state;
});

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  getUsageStats: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderQuotaHeadroom: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db/repos/routingRepo.js", () => ({
  insertRoutingEvent: vi.fn(async () => {}),
  applyJudgeScoreByRequestId: vi.fn(async () => {}),
  setUserRatingByRequestId: vi.fn(async () => {}),
  getPromotedLearningVersion: vi.fn(async () => null),
  getLearningVersionById: vi.fn(async () => null),
  getClusterWorkerStats: vi.fn(async () => []),
  getGlobalModelStats: vi.fn(async () => []),
  getClusterLatencyP50: vi.fn(async () => null),
  getProviderLatency: vi.fn(async () => ({})),
  setRoutingWriteHook: vi.fn(),
  getRoutingEvents: vi.fn(async () => []),
  createLearningVersion: vi.fn(async () => null),
  countRoutingEvents: vi.fn(async () => 0),
  listCombosWithRoutingEvents: vi.fn(async () => []),
  getLastScheduledLearnAt: vi.fn(async () => null),
}));

vi.mock("@/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

const BASE_SETTINGS = {
  requireApiKey: false,
  comboStrategies: {},
};

function configureCycle(comboModels, comboStrategies, maxReentries) {
  mocks.comboModels = comboModels;
  mocks.maxReentries = maxReentries;
  mocks.comboReentries = 0;
  mocks.getComboModels.mockClear();
  mocks.getModelInfo.mockClear();
  mocks.settings = {
    ...BASE_SETTINGS,
    comboStrategies,
  };
}

function cycleRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "combo-cycle-regression-test",
    },
    body: JSON.stringify({
      model: "A",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
  });
}

beforeEach(() => {
  configureCycle({}, {}, 0);
});

describe("combo cycle termination", () => {
  it("bounds a pure Auto-to-Auto cycle at the Auto depth cap", async () => {
    configureCycle(
      { A: ["A"] },
      { A: { fallbackStrategy: "auto", routerModel: "router/x" } },
      6
    );

    const response = await handleChat(cycleRequest());

    // Lower bound proves the cycle actually recursed (not an unrelated early-out);
    // upper bound proves it terminated. A removed guard blows past maxReentries.
    expect(mocks.comboReentries).toBeGreaterThanOrEqual(2);
    expect(mocks.comboReentries).toBeLessThanOrEqual(6);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);
  });

  it("bounds a mixed Auto-to-fallback cycle at the combo depth cap", async () => {
    configureCycle(
      { A: ["B"], B: ["A"] },
      {
        A: { fallbackStrategy: "auto", routerModel: "router/x" },
        B: { fallbackStrategy: "fallback" },
      },
      10
    );

    const response = await handleChat(cycleRequest());

    expect(mocks.comboReentries).toBeGreaterThanOrEqual(2);
    expect(mocks.comboReentries).toBeLessThanOrEqual(10);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);
  });

  it("bounds a pure fallback cycle at the combo depth cap", async () => {
    configureCycle(
      { A: ["B"], B: ["A"] },
      {
        A: { fallbackStrategy: "fallback" },
        B: { fallbackStrategy: "fallback" },
      },
      8
    );

    const response = await handleChat(cycleRequest());

    expect(mocks.comboReentries).toBeGreaterThanOrEqual(2);
    expect(mocks.comboReentries).toBeLessThanOrEqual(8);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);
  });
});
