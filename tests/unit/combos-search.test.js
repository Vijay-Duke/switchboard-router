import { describe, expect, it } from "vitest";
import { filterCombos } from "@/app/(dashboard)/dashboard/combos/CombosPageClient";

const combos = [
  { id: "1", name: "Coding", models: ["ds/deepseek-v4.1-flash", "cc/claude-sonnet-5"] },
  { id: "2", name: "fast-chat", models: ["groq/llama-4"] },
  { id: "3", name: "nested", models: ["Coding"] },
];

describe("filterCombos", () => {
  it("returns every combo for an empty or blank query", () => {
    expect(filterCombos(combos, "")).toBe(combos);
    expect(filterCombos(combos, "   ")).toBe(combos);
  });

  it("matches combo names case-insensitively", () => {
    expect(filterCombos(combos, "FAST").map((c) => c.id)).toEqual(["2"]);
  });

  it("matches member model ids, including nested combo names", () => {
    expect(filterCombos(combos, "deepseek-v4.1").map((c) => c.id)).toEqual(["1"]);
    expect(filterCombos(combos, "coding").map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("returns nothing when no name or model matches", () => {
    expect(filterCombos(combos, "zzz")).toEqual([]);
  });
});
