// @vitest-environment happy-dom
// O19: the proxy form re-seeds after a settings reload (DB import);
// O20: sticky limits PATCH once on blur, clamped.

import { afterEach, describe, expect, it, vi } from "vitest";
import ProfilePageClient from "@/app/(dashboard)/dashboard/profile/ProfilePageClient";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, settle, setValue, fire, jsonResponse } from "./dashboard-dom-harness.js";
import { act } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/profile",
}));

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
});

const baseSettings = {
  outboundProxyEnabled: true,
  outboundProxyUrl: "http://old-proxy:1",
  outboundNoProxy: "",
  fallbackStrategy: "round-robin",
  stickyRoundRobinLimit: 3,
  comboStickyRoundRobinLimit: 1,
};

const proxyInput = (container) => container.querySelector('input[placeholder="http://127.0.0.1:7897"]');

describe("profile proxy form resync (O19)", () => {
  it("re-seeds the proxy URL after a database import reloads settings", async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u === "/api/settings/database" && options.method === "POST") return Promise.resolve(jsonResponse({ ok: true }));
      if (u === "/api/settings") return Promise.resolve(jsonResponse({ ...baseSettings, outboundProxyUrl: "http://new-proxy:2" }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = await harness.mount(h(ProfilePageClient, { initialData: { settings: baseSettings, machineId: "m" } }));
    expect(proxyInput(container).value).toBe("http://old-proxy:1");

    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(["{}"], "backup.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(() => proxyInput(container)?.value === "http://new-proxy:2", "proxy url re-seeded");
  });
});

describe("profile sticky limit drafts (O20)", () => {
  it("PATCHes once on blur with the clamped value", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", fetchMock);
    const container = await harness.mount(h(ProfilePageClient, { initialData: { settings: baseSettings, machineId: "m" } }));
    const input = container.querySelector('input[aria-label="Sticky Limit"]');

    await setValue(input, "1");
    await setValue(input, "10");
    expect(fetchMock).not.toHaveBeenCalled();

    await fire(input, "focusout");
    await settle(() => fetchMock.mock.calls.length === 1, "one PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ stickyRoundRobinLimit: 10 });

    await setValue(input, "500");
    await fire(input, "keydown", { key: "Enter" });
    await settle(() => fetchMock.mock.calls.length === 2, "second PATCH");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ stickyRoundRobinLimit: 32 });
    expect(input.value).toBe("32");

    await fire(input, "focusout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
