// @vitest-environment happy-dom
// O11: getRemainingPercentage honours remainingPercentage and never yields NaN;
// O29: QuotaProgressBar clamps the rendered percentage to 0..100.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getRemainingPercentage } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import QuotaProgressBar from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaProgressBar";
import { createHarness, h } from "./dashboard-dom-harness.js";

const harness = createHarness();
afterEach(() => harness.unmount());

describe("getRemainingPercentage (O11)", () => {
  it.each([
    [{ remainingPercentage: 96, used: 95.5, total: 100 }, 96],
    [{ remainingPercentage: 50, used: 0, total: 0 }, 50],
    [{ used: 0, total: 0 }, null],
    [{ used: 25, total: 100 }, 75],
    [{ remaining: -3 }, null],
  ])("%j -> %i", (quota, expected) => {
    const value = getRemainingPercentage(quota);
    expect(value).toBe(expected);
  });

  it("the dead ProviderLimitCard is gone", () => {
    const dir = path.resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits");
    expect(fs.existsSync(path.join(dir, "ProviderLimitCard.js"))).toBe(false);
  });
});

describe("QuotaProgressBar clamp (O29)", () => {
  it.each([
    [-5, "0%"],
    [348, "100%"],
    [42.4, "42%"],
    ["abc", "Unknown"],
  ])("percentage %s renders %s", async (percentage, label) => {
    const container = await harness.mount(h(QuotaProgressBar, { name: "q", used: 0, total: 0, percentage }));
    const bar = container.querySelector('[style*="width"]');
    expect(bar.style.width).toBe(label === "Unknown" ? "0%" : label);
    expect(container.textContent).toContain(label);
    harness.unmount();
  });
});
