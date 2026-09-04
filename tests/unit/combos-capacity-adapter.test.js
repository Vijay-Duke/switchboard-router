// @vitest-environment happy-dom
// O13: every pool model gets remove/move controls, not just the first 3.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CapacityAdapterCap } from "@/app/(dashboard)/dashboard/combos/CombosPageClient";
import { createHarness, h, click } from "./dashboard-dom-harness.js";

const harness = createHarness();
afterEach(() => harness.unmount());

const cap = { id: "vision", label: "vision", desc: "image input", icon: "image" };

describe("CapacityAdapterCap (O13)", () => {
  it("renders a remove button per model and removes index 3", async () => {
    const onChange = vi.fn();
    const models = ["p/m1", "p/m2", "p/m3", "p/m4"];
    const container = await harness.mount(
      h(CapacityAdapterCap, { cap, entry: { enabled: true, roundRobin: false, models }, onChange, activeProviders: [] }),
    );

    const removeButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent.trim() === "close");
    expect(removeButtons).toHaveLength(4);
    expect(container.textContent).not.toContain("more");

    await click(removeButtons[3]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].models).toEqual(["p/m1", "p/m2", "p/m3"]);
  });
});
