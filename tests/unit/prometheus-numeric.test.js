import { describe, expect, it } from "vitest";
import { requireMetricNumber } from "../../src/lib/metrics/numeric.js";

describe("Prometheus numeric validation", () => {
  it("accepts only finite non-negative integer numbers for counts and tokens", () => {
    expect(requireMetricNumber(0, "count", { integer: true })).toBe(0);
    expect(requireMetricNumber(42, "count", { integer: true })).toBe(42);

    for (const value of ["", " ", "1", "0x10", "1.5", Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, null]) {
      expect(() => requireMetricNumber(value, "count", { integer: true })).toThrow("invalid Prometheus metric number");
    }
  });

  it("accepts finite non-negative numeric cost while rejecting text and negative values", () => {
    expect(requireMetricNumber(0, "cost")).toBe(0);
    expect(requireMetricNumber(0.125, "cost")).toBe(0.125);

    for (const value of ["0.125", " ", "0x10", Number.NaN, Number.NEGATIVE_INFINITY, -0.01, null]) {
      expect(() => requireMetricNumber(value, "cost")).toThrow("invalid Prometheus metric number");
    }
  });
});
