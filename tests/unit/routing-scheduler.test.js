import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The scheduler reads persistence through injected deps (M11) and calls the
// optimizer. Both are mocked so the tick is exercised with no DB and no timers.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listCombosWithRoutingEvents: vi.fn(),
  getLastScheduledLearnAt: vi.fn(),
  getComboModels: vi.fn(),
  runOptimizer: vi.fn(),
}));

vi.mock("../../open-sse/runtimeDeps.js", () => ({
  getSettings: mocks.getSettings,
  listCombosWithRoutingEvents: mocks.listCombosWithRoutingEvents,
  getLastScheduledLearnAt: mocks.getLastScheduledLearnAt,
  getComboModels: mocks.getComboModels,
}));

vi.mock("../../open-sse/routing/optimizer.js", () => ({
  runOptimizer: mocks.runOptimizer,
}));

const { runAutoLearnTick } = await import("../../open-sse/routing/scheduler.js");

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const HOUR = 3600 * 1000;
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** Build a settings object with one combo strategy. */
function settingsFor(strategy) {
  return { comboStrategies: { alpha: strategy } };
}

const AUTO_HOURLY = { fallbackStrategy: "auto", autoLearnIntervalHours: 1 };

describe("auto-learn scheduler tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The scheduler keeps a process-wide singleton to survive HMR, and closed
    // over it at import — so reset its fields in place rather than replacing
    // the object, or lastRunByCombo leaks from one case into the next.
    Object.assign(global.__autoLearnScheduler, { running: false, lastRunByCombo: {} });

    mocks.listCombosWithRoutingEvents.mockResolvedValue(["alpha"]);
    mocks.getLastScheduledLearnAt.mockResolvedValue(null);
    mocks.getComboModels.mockResolvedValue(["a/one", "b/two"]);
    mocks.runOptimizer.mockResolvedValue({ ok: true, message: "learned" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the optimizer for an auto combo that has never learned", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));

    const out = await runAutoLearnTick(silentLog);

    expect(out.ok).toBe(true);
    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
    expect(mocks.runOptimizer).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ source: "scheduled", force: false })
    );
    expect(out.results).toEqual([{ comboName: "alpha", ok: true, message: "learned" }]);
  });

  it.each([
    ["non-auto strategy", { fallbackStrategy: "fallback", autoLearnIntervalHours: 1 }],
    ["learning disabled", { ...AUTO_HOURLY, learningEnabled: false }],
    ["learning frozen", { ...AUTO_HOURLY, freezeLearning: true }],
    ["interval unset (manual only)", { fallbackStrategy: "auto" }],
    ["interval zero", { fallbackStrategy: "auto", autoLearnIntervalHours: 0 }],
    ["interval not a number", { fallbackStrategy: "auto", autoLearnIntervalHours: "soon" }],
  ])("skips the optimizer when %s", async (_label, strategy) => {
    mocks.getSettings.mockResolvedValue(settingsFor(strategy));

    const out = await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, results: [] });
  });

  it("skips a combo whose last scheduled run is inside the interval", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));
    mocks.getLastScheduledLearnAt.mockResolvedValue(new Date(NOW - 30 * 60 * 1000).toISOString());

    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).not.toHaveBeenCalled();
  });

  it("runs a combo whose last scheduled run is older than the interval", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));
    mocks.getLastScheduledLearnAt.mockResolvedValue(new Date(NOW - 2 * HOUR).toISOString());

    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
  });

  it("does not re-run a combo on the next tick inside the interval", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));

    await runAutoLearnTick(silentLog);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
  });

  it("retries on the next tick when the optimizer threw (last-run not advanced)", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));
    mocks.runOptimizer.mockRejectedValueOnce(new Error("upstream down"));

    const first = await runAutoLearnTick(silentLog);
    expect(first.results).toEqual([{ comboName: "alpha", ok: false, error: "upstream down" }]);

    vi.setSystemTime(NOW + 60 * 1000);
    const second = await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledTimes(2);
    expect(second.results[0].ok).toBe(true);
  });

  it("excludes the router model from the worker pool it passes to the optimizer", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor({ ...AUTO_HOURLY, routerModel: "a/one" }));

    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ pool: ["b/two"] })
    );
  });

  it("learns combos that have a strategy but no routing events yet", async () => {
    mocks.listCombosWithRoutingEvents.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));

    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
  });

  it("does not learn a combo twice when it is both in events and in settings", async () => {
    mocks.listCombosWithRoutingEvents.mockResolvedValue(["alpha", "alpha"]);
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));

    await runAutoLearnTick(silentLog);

    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
  });

  it("survives a routing-events read failure and still learns from settings", async () => {
    mocks.listCombosWithRoutingEvents.mockRejectedValue(new Error("db gone"));
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));

    const out = await runAutoLearnTick(silentLog);

    expect(out.ok).toBe(true);
    expect(mocks.runOptimizer).toHaveBeenCalledTimes(1);
  });

  it("refuses to run concurrently with an in-flight tick", async () => {
    mocks.getSettings.mockResolvedValue(settingsFor(AUTO_HOURLY));
    let releaseOptimizer;
    const entered = new Promise((markEntered) => {
      mocks.runOptimizer.mockImplementation(() => {
        markEntered();
        return new Promise((resolve) => { releaseOptimizer = () => resolve({ ok: true, message: "learned" }); });
      });
    });

    const inFlight = runAutoLearnTick(silentLog);
    await entered;

    expect(await runAutoLearnTick(silentLog)).toEqual({ skipped: true, reason: "already_running" });

    releaseOptimizer();
    await inFlight;
    // Lock released once the first tick finished.
    expect((await runAutoLearnTick(silentLog)).skipped).toBeUndefined();
  });
});
