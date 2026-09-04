// @vitest-environment happy-dom
// O24: mounting must not overwrite a saved expand-state with the initial
// empty Set before the load effect applies.

import { afterEach, describe, expect, it, vi } from "vitest";
import UsageTable from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import { createHarness, h, click } from "./dashboard-dom-harness.js";

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  localStorage.clear();
  vi.restoreAllMocks();
});

const props = (storageKey) => ({
  title: "By model",
  columns: [{ field: "name", label: "Name" }],
  groupedData: [
    { groupKey: "g1", summary: { pending: 0, totalTokens: 1 }, items: [{ id: "i1", name: "a", totalTokens: 1 }] },
  ],
  tableType: "model",
  sortBy: "name",
  sortOrder: "asc",
  onToggleSort: () => {},
  viewMode: "tokens",
  storageKey,
  renderDetailCells: () => null,
  renderSummaryCells: () => null,
});

describe("UsageTable expand persistence (O24)", () => {
  it("never writes [] over a saved expand state on mount", async () => {
    localStorage.setItem("usage-test-key", JSON.stringify(["g1"]));
    const setItem = vi.spyOn(localStorage, "setItem");

    await harness.mount(h(UsageTable, props("usage-test-key")));

    const writes = setItem.mock.calls.filter(([k]) => k === "usage-test-key").map(([, v]) => v);
    expect(writes).not.toContain("[]");
    expect(JSON.parse(localStorage.getItem("usage-test-key"))).toEqual(["g1"]);
  });

  it("still persists later user toggles", async () => {
    const container = await harness.mount(h(UsageTable, props("usage-toggle-key")));
    const rowButton = container.querySelector("button[aria-expanded]");
    if (rowButton) {
      await click(rowButton);
      expect(localStorage.getItem("usage-toggle-key")).not.toBeNull();
    }
  });
});
