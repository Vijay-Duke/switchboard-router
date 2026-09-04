// @vitest-environment happy-dom
// O23: the hidden PXPIPE section issues no /api/pxpipe requests on mount;
// O30: a failed RTK toggle PATCH toasts and leaves the switch unchanged.

import { afterEach, describe, expect, it, vi } from "vitest";
import TokenSaverClient from "@/app/(dashboard)/dashboard/token-saver/TokenSaverClient";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, settle, flush, click, fire, findByLabel, jsonResponse } from "./dashboard-dom-harness.js";

const harness = createHarness();

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
});

function stubFetch(patchStatus = 200) {
  const fetchMock = vi.fn((url, options = {}) => {
    const u = String(url);
    if (u === "/api/settings" && options.method === "PATCH") {
      return Promise.resolve(jsonResponse({ error: "settings write failed" }, patchStatus));
    }
    if (u === "/api/settings") return Promise.resolve(jsonResponse({ rtkEnabled: true }));
    if (u === "/api/headroom/status") {
      return Promise.resolve(jsonResponse({ installed: true, running: false, canStart: true, localUrl: "http://127.0.0.1:1" }));
    }
    if (u === "/api/headroom/start") return Promise.resolve(jsonResponse({ error: "spawn failed" }, 500));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const rtkSwitch = (container) => container.querySelector('[aria-label="Compress tool output (RTK)"]');

describe("token saver page (O23)", () => {
  it("does not call /api/pxpipe/* while the section is hidden", async () => {
    const fetchMock = stubFetch();
    const container = await harness.mount(h(TokenSaverClient));
    await settle(() => rtkSwitch(container), "page rendered");
    await flush(5);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain("/api/settings");
    expect(urls.filter((u) => u.includes("/api/pxpipe/"))).toEqual([]);
  });
});

describe("RTK toggle (O30)", () => {
  it("toasts the server error and keeps the switch state on a failed PATCH", async () => {
    stubFetch(500);
    const container = await harness.mount(h(TokenSaverClient));
    await settle(() => rtkSwitch(container)?.getAttribute("aria-checked") === "true", "rtk on");

    await click(rtkSwitch(container));
    await settle(
      () => useNotificationStore.getState().notifications.some((n) => n.message.includes("settings write failed")),
      "rtk error toast",
    );
    expect(rtkSwitch(container).getAttribute("aria-checked")).toBe("true");
  });
});

describe("headroom modal error reset (O23)", () => {
  it("clears the previous action error when the modal is closed and reopened", async () => {
    stubFetch();
    const container = await harness.mount(h(TokenSaverClient));
    await settle(() => findByLabel(container, "button", "Setup"), "setup link");

    await click(findByLabel(container, "button", "Setup"));
    await settle(() => findByLabel(document.body, "button", "Start Headroom"), "start button");
    await click(findByLabel(document.body, "button", "Start Headroom"));
    await settle(() => document.body.textContent.includes("spawn failed"), "error shown");

    await fire(document, "keydown", { key: "Escape" });
    await settle(() => !document.querySelector('[role="dialog"]'), "modal closed");
    await click(findByLabel(container, "button", "Setup"));
    await settle(() => document.querySelector('[role="dialog"]'), "modal reopened");
    expect(document.body.textContent).not.toContain("spawn failed");
  });
});
