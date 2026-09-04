// @vitest-environment happy-dom
// O21: providerOrder / providerLatencyGuardMs commit once on blur/Enter, not
// per keystroke.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ComboCard } from "@/app/(dashboard)/dashboard/combos/CombosPageClient";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHarness, h, setValue, fire, jsonResponse } from "./dashboard-dom-harness.js";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) => h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

const harness = createHarness();
afterEach(() => {
  harness.unmount();
  vi.unstubAllGlobals();
});

async function mountCard(strategy = {}) {
  // useModelCaps (via TierLabels) fetches /api/models on mount.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ models: [] }))));
  const onSetStrategy = vi.fn();
  const container = await harness.mount(
    h(
      QueryClientProvider,
      { client: new QueryClient() },
      h(ComboCard, {
        combo: { id: "c1", name: "combo-a", models: ["p/m1"] },
        // provider controls render only for Auto combos.
        strategy: { fallbackStrategy: "auto", routerModel: "p/m1", providerStrategy: "priority", ...strategy },
        onSetStrategy,
        onCopy: () => {},
        onEdit: () => {},
        onDelete: () => {},
      }),
    ),
  );
  return { container, onSetStrategy };
}

describe("ComboCard provider strategy drafts (O21)", () => {
  it("commits providerOrder once on blur after several keystrokes", async () => {
    const { container, onSetStrategy } = await mountCard();
    const input = container.querySelector('input[placeholder="provider-a, provider-b"]');
    expect(input).not.toBeNull();

    for (const text of ["a", "a,", "a, ", "a, b", "a, bc"]) await setValue(input, text);
    expect(onSetStrategy).not.toHaveBeenCalled();

    await fire(input, "focusout");
    expect(onSetStrategy).toHaveBeenCalledTimes(1);
    expect(onSetStrategy).toHaveBeenCalledWith({ providerOrder: ["a", "bc"] });
  });

  it("commits the latency guard on Enter and skips unchanged commits", async () => {
    const { container, onSetStrategy } = await mountCard({ providerLatencyGuardMs: 20000 });
    const input = container.querySelector('input[placeholder="20000"]');
    expect(input.value).toBe("20000");

    await fire(input, "focusout");
    expect(onSetStrategy).not.toHaveBeenCalled();

    await setValue(input, "15000");
    await fire(input, "keydown", { key: "Enter" });
    expect(onSetStrategy).toHaveBeenCalledTimes(1);
    expect(onSetStrategy).toHaveBeenCalledWith({ providerLatencyGuardMs: 15000 });
  });
});
