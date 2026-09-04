// @vitest-environment happy-dom
// W6: built-in providers order connected first, then available, then
// disabled last (alphabetical within each group). Exercises the exported
// rank helper plus the exact comparator the list section uses.

import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { rankBuiltInProviderEntry } from "@/app/(dashboard)/dashboard/providers/ProvidersPageClient.js";

function sortBuiltIn(entries, statsById) {
  return [...entries]
    .sort(([ka, a], [kb, b]) => {
      const ra = rankBuiltInProviderEntry(statsById[ka]);
      const rb = rankBuiltInProviderEntry(statsById[kb]);
      if (ra !== rb) return ra - rb;
      return (a.name || "").localeCompare(b.name || "");
    })
    .map(([k]) => k);
}

describe("rankBuiltInProviderEntry (W6)", () => {
  it("ranks connected before available before disabled", () => {
    expect(rankBuiltInProviderEntry({ connected: 2, total: 2 })).toBe(0);
    expect(rankBuiltInProviderEntry({ connected: 0, total: 0 })).toBe(1);
    expect(
      rankBuiltInProviderEntry({ connected: 0, total: 1, allDisabled: true }),
    ).toBe(2);
    // Disabled connections keep a "connected" testStatus; disabled still wins.
    expect(
      rankBuiltInProviderEntry({ connected: 1, total: 1, allDisabled: true }),
    ).toBe(2);
  });

  it("treats error-only active connections as available, not disabled", () => {
    expect(
      rankBuiltInProviderEntry({ connected: 0, total: 1, allDisabled: false }),
    ).toBe(1);
  });

  it("orders a mixed catalog connected, available, disabled with alpha ties", () => {
    const entries = [
      ["zebra", { name: "Zebra" }],
      ["alpha-disabled", { name: "Alpha" }],
      ["mid", { name: "Mid" }],
      ["apple-connected", { name: "Apple" }],
    ];
    const stats = {
      zebra: { connected: 1, total: 1, allDisabled: false },
      "alpha-disabled": { connected: 0, total: 1, allDisabled: true },
      mid: { connected: 0, total: 0, allDisabled: false },
      "apple-connected": { connected: 1, total: 2, allDisabled: false },
    };
    expect(sortBuiltIn(entries, stats)).toEqual([
      "apple-connected",
      "zebra",
      "mid",
      "alpha-disabled",
    ]);
  });
});
