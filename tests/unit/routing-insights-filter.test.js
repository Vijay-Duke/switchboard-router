// @vitest-environment happy-dom
// O6 (option b): the cluster/worker/exploration selects live inside the
// Recent decisions card and are labelled as decision filters, and the
// insights route documents that scope.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHarness, h, settle, jsonResponse } from "./dashboard-dom-harness.js";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("combo=auto"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) => h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

const { default: RoutingInsightsPage } = await import("@/app/(dashboard)/dashboard/combos/routing/page.js");

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  vi.unstubAllGlobals();
});

describe("routing insights filters (O6)", () => {
  it("places the decision filters inside the Recent decisions card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        if (String(url).startsWith("/api/routing/insights")) {
          return Promise.resolve(jsonResponse({
            clusters: ["c1"],
            workers: ["p/w1", "p/w2"],
            recent: [],
            explorationLog: [],
            heatmap: [],
            modelStats: [],
            scoreTrend: [],
          }));
        }
        return Promise.resolve(jsonResponse(null, 404));
      }),
    );
    const container = await harness.mount(h(RoutingInsightsPage));
    await settle(() => container.querySelector('[aria-label="Filter recent decisions by worker"]'), "filters rendered");

    const group = container.querySelector('[aria-label="Filter recent decisions"]');
    const heading = [...container.querySelectorAll("span")].find((s) => s.textContent.trim() === "Recent decisions");
    expect(heading).toBeTruthy();
    expect(heading.parentElement.contains(group)).toBe(true);
    expect(group.querySelectorAll("select")).toHaveLength(2);
    expect(group.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(group.textContent).toContain("filter decisions");
  });

  it("the insights route documents the filter scope", () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../src/app/api/routing/insights/route.js"),
      "utf8",
    );
    expect(src).toContain("filterScope");
    expect(src).toContain("recent/explorationLog only");
  });
});
