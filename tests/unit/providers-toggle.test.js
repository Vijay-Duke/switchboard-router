// @vitest-environment happy-dom
// D19: a failed provider toggle (one PUT 500) must revert the optimistic
// flip and surface an error toast.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ProvidersPageClient from "@/app/(dashboard)/dashboard/providers/ProvidersPageClient";
import { useNotificationStore } from "@/store/notificationStore";
import { useHeaderSearchStore } from "@/store/headerSearchStore";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) =>
    h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

let root = null;
let container = null;

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  useNotificationStore.getState().clearAll();
  useHeaderSearchStore.getState().unregister();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(predicate, label) {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    let done = false;
    try {
      done = !!predicate();
    } catch {
      done = false;
    }
    if (done) return;
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("provider toggle failure (D19)", () => {
  it("reverts the optimistic flip and toasts when one PUT 500s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const u = String(url);
        if (u === "/api/providers/c2" && options.method === "PUT") {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        }
        if (u.startsWith("/api/providers/") && options.method === "PUT") {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        h(ProvidersPageClient, {
          initialData: {
            connections: [
              { id: "c1", provider: "openai", authType: "apikey", name: "A", testStatus: "active", isActive: true },
              { id: "c2", provider: "openai", authType: "apikey", name: "B", testStatus: "active", isActive: true },
            ],
            nodes: [],
          },
        }),
      );
    });

    await settle(
      () => container.querySelector('[title="Disable provider"]'),
      "openai disable toggle",
    );

    // Disable the provider: c1 PUT ok, c2 PUT 500.
    await act(async () => {
      container.querySelector('[title="Disable provider"]').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    await settle(() => {
      const errors = useNotificationStore.getState().notifications.filter((n) => n.type === "error");
      const toggle = container.querySelector('[role="switch"]');
      return (
        errors.length > 0 &&
        toggle &&
        toggle.getAttribute("aria-checked") === "true"
      );
    }, "revert + error toast");

    const errors = useNotificationStore.getState().notifications.filter((n) => n.type === "error");
    expect(errors.some((n) => n.message.includes("Failed to disable"))).toBe(true);
  });
});
