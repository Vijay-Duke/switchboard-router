// @vitest-environment happy-dom
// U11 regression: exactly one nav link carries aria-current="page", the
// duplicated "cli tools" diagnostics entry is gone, and Chat is discoverable.
// No @testing-library in this repo; follows tests/unit/shared-modal-dialog.test.js
// (react-dom + act + happy-dom, React.createElement, no JSX).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.__React = React;
globalThis.__testPathname = "/dashboard/combos";

vi.mock("next/link", () => ({
  default: (props) => {
    const { href, children, prefetch, ...rest } = props;
    globalThis.__linkProps = globalThis.__linkProps || [];
    globalThis.__linkProps.push({ href, prefetch });
    return globalThis.__React.createElement("a", { href, ...rest }, children);
  },
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => globalThis.__testPathname,
}));

import Sidebar from "@/shared/components/Sidebar";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

beforeEach(() => {
  globalThis.__linkProps = [];
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes("/api/health")) return { ok: true, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => ({}) };
  });
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

async function renderSidebar() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(Sidebar, {}));
  });
}

describe("Sidebar navigation IA (U11)", () => {
  it("marks exactly one link with aria-current=page (the active one)", async () => {
    await renderSidebar();
    const current = container.querySelectorAll('a[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0].getAttribute("href")).toBe("/dashboard/combos");
  });

  it("has exactly one link to /dashboard/cli-tools (no diagnostics duplicate)", async () => {
    await renderSidebar();
    const cliLinks = container.querySelectorAll('a[href="/dashboard/cli-tools"]');
    expect(cliLinks.length).toBe(1);
  });

  it("exposes the Chat page in the Operate section", async () => {
    await renderSidebar();
    const chat = container.querySelector('a[href="/dashboard/basic-chat"]');
    expect(chat).not.toBeNull();
    expect(chat.textContent).toContain("Chat");
  });

  it("disables viewport prefetch on every nav and diagnostics link (W2)", async () => {
    await renderSidebar();
    const dashboardLinks = globalThis.__linkProps.filter(
      ({ href }) => typeof href === "string" && href.startsWith("/dashboard")
    );
    expect(dashboardLinks.length).toBeGreaterThan(10);
    for (const { href, prefetch } of dashboardLinks) {
      expect(prefetch, href).toBe(false);
    }
  });
});
