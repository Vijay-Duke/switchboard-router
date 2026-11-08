// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomConfigCard from "@/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, click, setValue, settle, findByText, jsonResponse } from "./dashboard-dom-harness.js";

const harness = createHarness();
afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
});

describe("custom provider headers", () => {
  it("keeps edits and allows retry after a network failure", async () => {
    const put = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ headers: { "X-Client": "edited" } }));
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => options.method === "PUT"
      ? put(url, options)
      : Promise.resolve(jsonResponse({ builtinHeaders: { "X-Client": "default" }, headers: {} }))));
    const container = await harness.mount(h(CustomConfigCard, { providerId: "qoder" }));
    await settle(() => container.textContent.includes("Custom Headers"), "header card");
    await click(container.querySelector("button"));
    const value = container.querySelector('input[placeholder="Value"]');
    await setValue(value, "edited");
    await click(findByText(container, "button", "Save"));
    await settle(() => useNotificationStore.getState().notifications.some((n) => n.type === "error"), "network error toast");
    expect(value.value).toBe("edited");
    expect(findByText(container, "button", "Save").disabled).toBe(false);
    expect(container.textContent).not.toContain("Active");
    await click(findByText(container, "button", "Save"));
    await settle(() => container.textContent.includes("Active"), "saved override badge");
    expect(put).toHaveBeenCalledTimes(2);
    expect(JSON.parse(put.mock.calls[1][1].body)).toEqual({ headers: { "X-Client": "edited" } });
    expect(useNotificationStore.getState().notifications.some((n) => n.type === "success")).toBe(true);
  });
});
