import { describe, expect, it, vi } from "vitest";

const state = { events: ["old"], versions: ["old"] };
const db = {
  run: vi.fn((sql) => {
    if (sql.includes("routing_events")) state.events = ["new"];
    if (sql.includes("router_learning_versions")) throw new Error("version table unavailable");
  }),
  transaction: vi.fn((fn) => {
    const snapshot = { events: [...state.events], versions: [...state.versions] };
    try {
      fn();
    } catch (error) {
      state.events = snapshot.events;
      state.versions = snapshot.versions;
      throw error;
    }
  }),
};

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => db),
}));

const { rekeyRoutingDataForCombo } = await import("../../src/lib/db/repos/routingRepo.js");

describe("rekeyRoutingDataForCombo", () => {
  it("rolls back the first table when the second update fails", async () => {
    await expect(rekeyRoutingDataForCombo("old", "new")).rejects.toThrow("version table unavailable");

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(state).toEqual({ events: ["old"], versions: ["old"] });
  });
});
