import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ getSettings: vi.fn() }));
const adapter = vi.hoisted(() => ({ transaction: vi.fn(), run: vi.fn() }));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => settings);
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => adapter }));

const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

describe("observability setting", () => {
  it("does not buffer details when the dashboard disables observability", async () => {
    settings.getSettings.mockResolvedValue({ enableObservability: false });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await saveRequestDetail({ model: "test", response: { content: "secret" } });

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
