import { describe, expect, it } from "vitest";
import { formatNum } from "@/app/(dashboard)/dashboard/OverviewClient";

describe("formatNum boundary rounding (D2)", () => {
  it("renders 999949 as k", () => {
    expect(formatNum(999949)).toBe("999.9k");
  });

  it("rounds 999950 up to M", () => {
    expect(formatNum(999950)).toBe("1.0M");
  });

  it("renders 999999 as M, never 1000.0k", () => {
    expect(formatNum(999999)).toBe("1.0M");
  });

  it("keeps ordinary values unchanged", () => {
    expect(formatNum(0)).toBe("0");
    expect(formatNum(42)).toBe("42");
    expect(formatNum(1500)).toBe("1.5k");
    expect(formatNum(1_000_000)).toBe("1.0M");
    expect(formatNum(2_500_000)).toBe("2.5M");
  });
});
