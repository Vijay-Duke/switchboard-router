// @vitest-environment happy-dom
// Behavioral regression tests for media-providers [kind]/[id] detail page
// (round-2 T102-T104): T102 server error vs notFound, T103 stale node reset
// on id change, T104 encoded delete URL. React.createElement (no JSX loader).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }) => h("a", { href: typeof href === "string" ? href : href?.pathname }, children),
}));

let paramsMock = { kind: "embedding", id: "custom-embedding-acme" };
let pushMock = null;
vi.mock("next/navigation", () => ({
  useParams: () => paramsMock,
  useRouter: () => ({ push: pushMock, replace: () => {}, refresh: () => {} }),
  notFound: () => h("div", { "data-testid": "not-found" }),
  usePathname: () => "/dashboard/media-providers/embedding/x",
  useSearchParams: () => new URLSearchParams(),
}));
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn(async () => true) }));
vi.mock("@/store/confirmationStore", () => ({ requestConfirmation: confirmMock }));

import DetailPage from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  headers: { get: () => "application/json" },
});

const NODES = [
  { id: "custom-embedding-acme", name: "Node A", prefix: "acme" },
  { id: "custom-embedding-beta", name: "Node B", prefix: "beta" },
  { id: "custom-embedding-ac me", name: "Node Space", prefix: "sp" },
];

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

beforeEach(() => {
  pushMock = vi.fn();
  paramsMock = { kind: "embedding", id: "custom-embedding-acme" };
  confirmMock.mockClear();
  fetchMock = vi.fn((url) =>
    Promise.resolve(url === "/api/provider-nodes"
      ? jsonResponse({ nodes: NODES })
      : jsonResponse({})));
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

describe("media-providers detail page (custom embedding node)", () => {
  it("T102: /api/provider-nodes 500 shows an error alert, not NotFound", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: "boom" }, { ok: false, status: 500 })));
    mount(h(DetailPage));
    await flush();

    expect(container.querySelector('[data-testid="not-found"]')).toBeNull();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Couldn't load this provider node");
  });

  it("T103: switching id drops the previous node instead of flashing it", async () => {
    mount(h(DetailPage));
    await flush();
    expect(container.textContent).toContain("Node A");

    // Navigation to another custom node: fetch never settles -> must show
    // Loading, not the previous node's data.
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/provider-nodes"
        ? new Promise(() => {})
        : jsonResponse({})));

    paramsMock = { kind: "embedding", id: "custom-embedding-beta" };
    await act(async () => {
      root.render(h(DetailPage));
    });
    await flush();

    expect(container.textContent).not.toContain("Node A");
    expect(container.textContent).toContain("Loading");
  });

  it("T104: delete requests the encodeURIComponent'd node id", async () => {
    paramsMock = { kind: "embedding", id: "custom-embedding-ac me" };
    mount(h(DetailPage));
    await flush();

    const del = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Delete"));
    expect(del).not.toBeNull();
    await act(async () => {
      del.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    const call = fetchMock.mock.calls.find(([u, i]) => String(u).startsWith("/api/provider-nodes/") && i?.method === "DELETE");
    expect(call).toBeDefined();
    expect(call[0]).toBe("/api/provider-nodes/custom-embedding-ac%20me");
  });
});
