// @vitest-environment happy-dom
// W9 client: mounting the Sidebar twice (desktop + mobile drawer) issues a
// single /api/version request thanks to the module-level shared promise.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.__React = React;

vi.mock("next/link", () => ({
  default: (props) => {
    const { href, children, ...rest } = props;
    return globalThis.__React.createElement("a", { href, ...rest }, children);
  },
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

import Sidebar from "@/shared/components/Sidebar";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots = [];
const containers = [];

async function renderSidebar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(Sidebar, {}));
  });
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    act(() => root.unmount());
  }
  while (containers.length) containers.pop().remove();
  vi.restoreAllMocks();
});

describe("Sidebar version fetch sharing (W9)", () => {
  it("fetches /api/version once across two mounts", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/api/health"))
        return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({ hasUpdate: false }),
      };
    });
    await renderSidebar();
    await renderSidebar();
    const versionCalls = globalThis.fetch.mock.calls.filter(([u]) =>
      String(u).includes("/api/version"),
    );
    expect(versionCalls).toHaveLength(1);
  });
});
