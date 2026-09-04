// @vitest-environment happy-dom
// O2: delete/toggle/edit/bulk surface HTTP errors as toasts; O7: auto-ping
// toggle reverts on a failed PATCH; O15: the reset-credit modal is a real
// dialog that closes on Escape.

import { afterEach, describe, expect, it, vi } from "vitest";
import ProviderLimits from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, settle, click, fire, jsonResponse } from "./dashboard-dom-harness.js";

vi.mock("@/store/confirmationStore", () => ({
  requestConfirmation: vi.fn(() => Promise.resolve(true)),
}));

const harness = createHarness();

const CONNECTION = {
  id: "c1",
  provider: "codex",
  authType: "oauth",
  name: "Codex A",
  isActive: true,
};

function stubFetch(overrides = {}) {
  const fetchMock = vi.fn((url, options = {}) => {
    const u = String(url);
    const method = options.method || "GET";
    const key = `${method} ${u.split("?")[0]}`;
    if (overrides[key]) return Promise.resolve(overrides[key](u, options));
    if (u.startsWith("/api/providers/client")) {
      return Promise.resolve(jsonResponse({
        connections: [CONNECTION],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
        totals: { eligibleConnections: 1, providerFilteredConnections: 1 },
        providerOptions: [],
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const toasts = () => useNotificationStore.getState().notifications.map((n) => n.message);

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountWithRow(overrides) {
  const fetchMock = stubFetch(overrides);
  const container = await harness.mount(h(ProviderLimits));
  await settle(() => container.querySelector('[aria-label="Delete connection"]'), "connection row");
  return { fetchMock, container };
}

describe("ProviderLimits mutations (O2)", () => {
  it("toasts the server error and keeps the row when DELETE is rejected", async () => {
    const { container, fetchMock } = await mountWithRow({
      "DELETE /api/providers/c1": () => jsonResponse({ error: "in use" }, 409),
    });

    await click(container.querySelector('[aria-label="Delete connection"]'));
    await settle(() => toasts().some((m) => m.includes("in use")), "error toast");

    expect(fetchMock).toHaveBeenCalledWith("/api/providers/c1", expect.objectContaining({ method: "DELETE" }));
    expect(container.textContent).toContain("Codex A");
  });

  it("toasts when the active toggle PUT fails", async () => {
    const { container } = await mountWithRow({
      "PUT /api/providers/c1": () => jsonResponse({ error: "db locked" }, 500),
    });
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();

    await click(toggle);
    await settle(() => toasts().some((m) => m.includes("db locked")), "toggle error toast");
  });
});

describe("auto-ping toggle (O7)", () => {
  it("reverts the optimistic bolt and toasts when the settings PATCH fails", async () => {
    const { container } = await mountWithRow({
      "PATCH /api/settings": () => jsonResponse({ error: "settings write failed" }, 500),
    });
    const bolt = container.querySelector('[aria-label="Toggle auto-ping"]');
    expect(bolt).not.toBeNull();
    expect(bolt.className).toContain("text-text-muted");

    await click(bolt);
    await settle(() => toasts().some((m) => m.includes("settings write failed")), "auto-ping error toast");

    expect(container.querySelector('[aria-label="Toggle auto-ping"]').className).toContain("text-text-muted");
  });
});

describe("reset-credit modal (O15)", () => {
  it("opens as a dialog and closes on Escape", async () => {
    const { container } = await mountWithRow({
      "GET /api/usage/c1/codex-reset-credits": () => jsonResponse({ credits: [], availableCount: 0 }),
    });

    await click(container.querySelector('[aria-label="View Codex reset credit expiry"]'));
    await settle(() => document.querySelector('[role="dialog"]'), "dialog open");
    expect(document.body.textContent).toContain("Codex Reset Credit Expiry");

    await fire(document, "keydown", { key: "Escape" });
    await settle(() => !document.querySelector('[role="dialog"]'), "dialog closed");
  });
});
