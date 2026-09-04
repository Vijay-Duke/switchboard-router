// @vitest-environment happy-dom
// O9: the in-card pager keeps its page across same-content refreshes and
// resets only when the row set changes.

import { afterEach, describe, expect, it } from "vitest";
import QuotaTable from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable";
import { createHarness, h, click, findByText } from "./dashboard-dom-harness.js";

const harness = createHarness();
afterEach(() => harness.unmount());

const makeQuotas = (n) =>
  Array.from({ length: n }, (_, i) => ({ name: `quota-${i}`, used: i, total: 100, resetAt: null }));

describe("QuotaTable paging (O9)", () => {
  it("preserves the page when quotas are refreshed with identical content", async () => {
    const container = await harness.mount(h(QuotaTable, { quotas: makeQuotas(25) }));
    await click(findByText(container, "button", "Next"));
    expect(container.textContent).toContain("Page 2 / 3");

    await harness.rerender(h(QuotaTable, { quotas: makeQuotas(25) }));
    expect(container.textContent).toContain("Page 2 / 3");
  });

  it("resets to page 1 when the row set changes", async () => {
    const container = await harness.mount(h(QuotaTable, { quotas: makeQuotas(25) }));
    await click(findByText(container, "button", "Next"));
    expect(container.textContent).toContain("Page 2 / 3");

    await harness.rerender(h(QuotaTable, { quotas: [...makeQuotas(24), { name: "other", used: 0, total: 1 }] }));
    expect(container.textContent).toContain("Page 1 / 3");
  });
});
