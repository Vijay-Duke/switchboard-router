// @vitest-environment happy-dom
// Shared harness for provider-detail page render tests (D16/D17/D18):
// mounts the real page with a route-based fetch mock.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import ProviderDetailPage from "@/app/(dashboard)/dashboard/providers/[id]/page";
import { useNotificationStore } from "@/store/notificationStore";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { paramsMock } = vi.hoisted(() => ({ paramsMock: { id: "openai" } }));

export function setProviderId(id) {
  paramsMock.id = id;
}

vi.mock("next/navigation", () => ({
  useParams: () => paramsMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) =>
    h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

vi.mock("next/image", () => ({
  default: (props) => h("img", { ...props, alt: props.alt || "" }),
}));

export function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

export function errJson(status, data) {
  return { ok: false, status, json: () => Promise.resolve(data) };
}

// Route-based fetch mock. `routes` maps "METHOD path-prefix" to a handler
// returning a response object. Unmatched GETs resolve an empty ok payload.
export function stubPageFetch({ connections = [], nodes = [], routes = {} }) {
  const calls = [];
  const handler = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || "GET").toUpperCase();
    calls.push({ url: u, method, options });
    const route = routes[`${method} ${u}`] || routes[`${method} *`] || routes[u];
    if (route) return route(u, options);
    if (method === "GET") {
      if (u === "/api/providers") return okJson({ connections });
      if (u === "/api/provider-nodes") return okJson({ nodes });
      if (u === "/api/settings") return okJson({ providerStrategies: {} });
      if (u === "/api/models/alias") return okJson({ aliases: {} });
      if (u === "/api/models/custom") return okJson({ models: [] });
      if (u.startsWith("/api/models/disabled")) return okJson({ ids: [] });
      if (u === "/api/models") return okJson({ models: [] });
      if (u.endsWith("/model-probes")) return okJson({ probes: [] });
      if (u.includes("suggested-models")) return okJson({ data: [] });
      if (u.includes("verify/status")) return okJson({ status: "idle" });
      if (/\/api\/providers\/[^/]+\/models$/.test(u)) return okJson({ models: [] });
      return okJson({});
    }
    return okJson({});
  };
  vi.stubGlobal("fetch", vi.fn(handler));
  return calls;
}

export function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

export async function renderPage(harness) {
  await act(async () => {
    harness.root.render(h(ProviderDetailPage, null));
  });
}

export function unmountPage(harness) {
  act(() => harness.root.unmount());
  harness.container.remove();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

// Polls inside act until predicate passes (bounded).
export async function settle(predicate, label) {
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

export function errorToasts() {
  return useNotificationStore
    .getState()
    .notifications.filter((n) => n.type === "error");
}

export function click(el) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}
