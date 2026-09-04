// @vitest-environment happy-dom
// O14: the endpoint-local Tooltip is keyboard reachable and described.

import { afterEach, describe, expect, it } from "vitest";
import Tooltip from "@/app/(dashboard)/dashboard/endpoint/components/Tooltip";
import { createHarness, h } from "./dashboard-dom-harness.js";

const harness = createHarness();
afterEach(() => harness.unmount());

describe("endpoint Tooltip a11y (O14)", () => {
  it("has a focusable trigger whose aria-describedby resolves to the tooltip", async () => {
    const container = await harness.mount(h(Tooltip, { text: "Helpful text" }));
    const trigger = container.querySelector("[tabindex]");
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("tabindex")).toBe("0");

    const tip = document.getElementById(trigger.getAttribute("aria-describedby"));
    expect(tip).not.toBeNull();
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe("Helpful text");
    // Mirrors the shared Tooltip: shows on hover and keyboard focus.
    expect(tip.className).toContain("group-hover:opacity-100");
    expect(tip.className).toContain("group-has-focus-visible:opacity-100");

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });
});
