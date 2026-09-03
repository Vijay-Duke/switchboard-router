// @vitest-environment happy-dom
// U7 regression: dashboard toasts must be announced to assistive tech — the
// toast stack carries role=status + aria-live=polite, and error toasts carry
// role=alert. JSX is avoided (React.createElement) because the vitest
// transform only parses JSX inside src/**.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));
vi.mock("@/shared/components/Sidebar", () => ({
  default: () => null,
}));
vi.mock("@/shared/components/Header", () => ({
  default: () => null,
}));
vi.mock("@/shared/components/GlobalConfirmModal", () => ({
  default: () => null,
}));

import DashboardLayout from "@/shared/components/layouts/DashboardLayout";
import { useNotificationStore } from "@/store/notificationStore";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(h(DashboardLayout, { endpointHost: "127.0.0.1:20128" }, h("div", null, "page body")));
  });
  return container;
}

beforeEach(() => {
  useNotificationStore.getState().clearAll();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  useNotificationStore.getState().clearAll();
});

describe("dashboard toast accessibility (U7)", () => {
  it("announces an error toast via role=alert inside an aria-live=polite stack", () => {
    useNotificationStore.getState().error("alias in use");
    const el = mount();

    const stack = el.querySelector('[aria-live="polite"]');
    expect(stack).not.toBeNull();
    expect(stack.getAttribute("role")).toBe("status");
    expect(stack.getAttribute("aria-relevant")).toBe("additions");

    const alert = stack.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("alias in use");
  });

  it("does not mark non-error toasts as alerts", () => {
    useNotificationStore.getState().info("just FYI");
    const el = mount();

    const stack = el.querySelector('[aria-live="polite"]');
    expect(stack).not.toBeNull();
    expect(stack.textContent).toContain("just FYI");
    expect(stack.querySelector('[role="alert"]')).toBeNull();
  });
});
