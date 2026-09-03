// P9: getSettings() memoizes the settings blob for 2 s; updateSettings
// invalidates; callers get a copy so they cannot poison the memo.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: mocks.get,
    run: mocks.run,
    transaction: (fn) => fn(),
  }),
}));

const { getSettings, updateSettings, __resetSettingsCacheForTests } = await import(
  "../../src/lib/db/repos/settingsRepo.js"
);

let stored;

beforeEach(() => {
  __resetSettingsCacheForTests();
  stored = { comboStrategy: "fallback" };
  mocks.get.mockReset().mockImplementation(() => ({ data: JSON.stringify(stored) }));
  mocks.run.mockReset().mockImplementation((_sql, params) => {
    stored = JSON.parse(params[0]);
  });
});

describe("settings cache", () => {
  it("reads the DB once across three getSettings() calls", async () => {
    const a = await getSettings();
    const b = await getSettings();
    const c = await getSettings();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("returns copies so caller mutation does not poison the memo", async () => {
    const a = await getSettings();
    a.comboStrategy = "mutated";
    a.injected = true;
    const b = await getSettings();
    expect(b.comboStrategy).toBe("fallback");
    expect(b.injected).toBeUndefined();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("updateSettings invalidates and the next read reflects the write", async () => {
    await getSettings();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await updateSettings({ customKey: 1 });
    const next = await getSettings();
    expect(next.customKey).toBe(1);
    // update's own SELECT + one re-read; no repeat reads after that.
    expect(mocks.get).toHaveBeenCalledTimes(3);
    await getSettings();
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });
});
