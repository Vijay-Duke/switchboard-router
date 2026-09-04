// @vitest-environment happy-dom
// D1: the quota/endpoint cards must show the connection count (not the
// distinct-provider count); the onboarding gate still keys off providerCount.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import OverviewClient from "@/app/(dashboard)/dashboard/OverviewClient";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) =>
    h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

let root = null;
let container = null;

async function mount(initialData) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(OverviewClient, { initialData }));
  });
}

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

function stubStats() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
  );
}

describe("overview connection vs provider counts (D1)", () => {
  it("labels 3 connections of 1 provider as 3 connections", async () => {
    stubStats();
    await mount({ providerCount: 1, connectionCount: 3, keyCount: 2, readyProviderCount: 1 });

    expect(container.textContent).toContain("3 connections");
    expect(container.textContent).not.toContain("1 connections");
    expect(container.textContent).toContain("3 providers connected");
  });

  it("keeps the onboarding gate on providerCount", async () => {
    stubStats();
    await mount({ providerCount: 0, connectionCount: 0, keyCount: 0 });
    expect(container.textContent).toContain("Connect your first provider to get started");
  });

  it("hides the onboarding gate once a provider exists", async () => {
    stubStats();
    await mount({ providerCount: 1, connectionCount: 3, keyCount: 2, readyProviderCount: 1 });
    expect(container.textContent).not.toContain("Connect your first provider to get started");
  });

  it("falls back to providerCount when connectionCount is absent (legacy initialData)", async () => {
    stubStats();
    await mount({ providerCount: 2, readyProviderCount: 1 });
    expect(container.textContent).toContain("2 connections");
  });
});
