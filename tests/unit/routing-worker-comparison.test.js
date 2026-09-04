// O26: routing timestamps render in local time; O27: unscored workers show
// "—" instead of a fake 0.

import { describe, expect, it } from "vitest";
import {
  formatWorkerScoreLabel,
  formatRoutingTimestamp,
} from "@/app/(dashboard)/dashboard/combos/routing/page.js";

describe("formatWorkerScoreLabel (O27)", () => {
  it("renders — for null/undefined and a rounded number otherwise", () => {
    expect(formatWorkerScoreLabel(null)).toBe("—");
    expect(formatWorkerScoreLabel(undefined)).toBe("—");
    expect(formatWorkerScoreLabel(71.6)).toBe(72);
    expect(formatWorkerScoreLabel(0)).toBe(0);
  });
});

describe("formatRoutingTimestamp (O26)", () => {
  it("renders the local time for a UTC ISO fixture", () => {
    const iso = "2026-08-05T13:07:00.000Z";
    const rendered = formatRoutingTimestamp(iso);
    expect(rendered).toBe(new Date(iso).toLocaleString());
    expect(rendered).not.toBe(iso.slice(0, 19).replace("T", " "));
  });

  it("passes through unparseable values and dashes empties", () => {
    expect(formatRoutingTimestamp("not a date")).toBe("not a date");
    expect(formatRoutingTimestamp(null)).toBe("—");
  });
});
