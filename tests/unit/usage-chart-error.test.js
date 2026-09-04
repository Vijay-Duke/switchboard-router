// @vitest-environment happy-dom
// O25: a failed chart fetch shows an error state with a working Retry.

import { afterEach, describe, expect, it, vi } from "vitest";
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, settle, click, jsonResponse, findByText } from "./dashboard-dom-harness.js";

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
});

describe("UsageChart error state (O25)", () => {
  it("renders the error caption on a 500 and refetches on Retry", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ error: "boom" }, 500)));
    vi.stubGlobal("fetch", fetchMock);

    const container = await harness.mount(h(UsageChart, { period: "7d" }));
    await settle(() => container.textContent.includes("Failed to load chart"), "error caption");
    expect(container.textContent).not.toContain("No data for this period");

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    await click(findByText(container, "button", "Retry"));
    await settle(() => container.textContent.includes("No data for this period"), "empty state after retry");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Failed to load chart");
  });
});
