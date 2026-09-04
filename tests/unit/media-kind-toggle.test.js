// @vitest-environment happy-dom
// Behavioral regression tests for media-providers [kind] page (round-2 T99-T101):
// T99 toggle rollback on failed toggle, T100 toggle a11y + no navigation,
// T101 load-failure alert with retry. Uses React.createElement (no JSX loader
// for tests/, matching tests/unit/shared-modal-dialog.test.js).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }) => h("a", { href: typeof href === "string" ? href : href?.pathname }, children),
}));

let pushMock = null;
let replaceMock = null;

vi.mock("next/navigation", () => ({
  useParams: () => ({ kind: "image" }),
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: () => {} }),
  notFound: () => null,
  usePathname: () => "/dashboard/media-providers/image",
  useSearchParams: () => new URLSearchParams(),
}));

import KindPage from "@/app/(dashboard)/dashboard/media-providers/[kind]/page";
import { useNotificationStore } from "@/store/notificationStore";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  headers: { get: () => "application/json" },
});

function route(url, init) {
  if (url === "/api/providers" && !init?.method) {
    return jsonResponse({ connections: [{ id: "c1", provider: "openai", isActive: true }] });
  }
  if (url === "/api/providers/c1" && init?.method === "PUT") {
    return jsonResponse({ error: "nope" }, { ok: false, status: 500 });
  }
  return jsonResponse({});
}

let root = null;
let container = null;
let fetchMock = null;

function mount(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(element));
}

async function flush() {
  await act(async () => {});
}

function clickSwitch() {
  const toggle = container.querySelector('button[role="switch"]');
  expect(toggle).not.toBeNull();
  act(() => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  return toggle;
}

beforeEach(() => {
  pushMock = vi.fn();
  replaceMock = vi.fn();
  fetchMock = vi.fn((url, init) => Promise.resolve(route(url, init)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("media-providers [kind] page", () => {
  it("T99: failed disable rolls the toggle back to ON and reports an error", async () => {
    mount(h(KindPage));
    await flush();

    const before = container.querySelector('button[role="switch"]');
    expect(before).not.toBeNull();
    expect(before.getAttribute("aria-checked")).toBe("true");

    clickSwitch();
    await flush();

    // PUT /api/providers/c1 returned 500 — UI must revert to checked=ON.
    const after = container.querySelector('button[role="switch"]');
    expect(after.getAttribute("aria-checked")).toBe("true");
    const notes = useNotificationStore.getState().notifications;
    expect(notes.some((n) => String(n.message).includes("Failed to"))).toBe(true);
  });

  it("T100: toggle is a real switch (role/aria-checked) and flipping it does not navigate", async () => {
    mount(h(KindPage));
    await flush();

    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // PUT succeeds for this scenario
    fetchMock.mockImplementation((url, init) =>
      Promise.resolve(url === "/api/providers/c1" && init?.method === "PUT"
        ? jsonResponse({ connection: { id: "c1", isActive: false } })
        : route(url, init))
    );

    clickSwitch();
    await flush();

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // The card is a Link; flipping the toggle must not navigate.
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("T101: failed /api/providers load shows an alert with retry, not a silent empty page", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: "boom" }, { ok: false, status: 500 })));
    mount(h(KindPage));
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Couldn't load provider connections");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).not.toBeNull();
  });
});
