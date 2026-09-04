// @vitest-environment happy-dom
// Behavioral regression test (round-2 T112): MITM page surfaces provider-load
// failure with a retry affordance instead of rendering silently-broken
// model mapping pickers. React.createElement (no JSX loader in tests/).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }) => h("a", { href: typeof href === "string" ? href : href?.pathname }, children),
}));

vi.mock("@/app/(dashboard)/dashboard/cli-tools/components", () => ({
  MitmServerCard: () => h("div", { "data-testid": "mitm-server-card" }),
  MitmToolCard: () => h("div", { "data-testid": "mitm-tool-card" }),
}));

import MitmPageClient from "@/app/(dashboard)/dashboard/mitm/MitmPageClient";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  headers: { get: () => "application/json" },
});

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
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse({})));
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

describe("MitmPageClient", () => {
  it("T112: any failed data load shows an alert banner with retry", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/providers"
        ? jsonResponse({ error: "boom" }, { ok: false, status: 500 })
        : jsonResponse({})));

    mount(h(MitmPageClient));
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Couldn't load provider data");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry");
    expect(retry).not.toBeNull();
  });

  it("T112: a clean load shows no alert banner", async () => {
    mount(h(MitmPageClient));
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
