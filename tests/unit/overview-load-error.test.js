// @vitest-environment happy-dom
// Regression tests for T13 (U2/U3): the Overview page must not disguise
// backend failures as an empty account, and the Quota card must not render
// fake quota data. Follows the react-dom/client + act pattern used by
// tests/unit/shared-modal-dialog.test.js (React.createElement, no JSX).

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import OverviewClient from "@/app/(dashboard)/dashboard/OverviewClient";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) =>
    h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

let root = null;
let container = null;

function okStatsResponse(data = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

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
  refreshMock.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("overview load errors (U2)", () => {
  it("shows an alert and hides the first-provider CTA when initialData carries loadError", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okStatsResponse())));
    await mount({ providerCount: 0, loadError: "boom" });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Couldn't read dashboard data: boom");
    expect(container.textContent).not.toContain("Connect your first provider");
  });

  it("shows the first-provider CTA and no alert when there is no loadError", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okStatsResponse())));
    await mount({ providerCount: 0 });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Connect your first provider");
  });

  it("retry button refreshes the route", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okStatsResponse())));
    await mount({ providerCount: 0, loadError: "db is down" });

    const retry = container.querySelector('[role="alert"] button');
    expect(retry).not.toBeNull();
    expect(retry.textContent).toBe("Retry");
    act(() => {
      retry.click();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("renders em-dash tiles and a status caption when the 24h stats fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("500"))));
    await mount({ providerCount: 2, readyProviderCount: 1 });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status.textContent).toContain("stats unavailable");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("renders em-dash tiles and a status caption when the 24h stats fetch is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    await mount({ providerCount: 2, readyProviderCount: 1 });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status.textContent).toContain("stats unavailable");
  });

  it("renders em-dash tiles (never 0) while the 24h stats fetch is pending", async () => {
    let resolveFetch;
    const statsPayload = {
      totalRequests: 42,
      totalPromptTokens: 1000,
      totalCompletionTokens: 50,
      totalCost: 1.5,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve(okStatsResponse(statsPayload));
          })
      )
    );
    await mount({ providerCount: 2, readyProviderCount: 1 });

    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("$0.00");
    // No error caption while merely pending.
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      resolveFetch();
    });
    expect(container.textContent).toContain("42");
    expect(container.textContent).toContain("$1.50");
  });

  it("renders live stat values with no status caption when the stats fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          okStatsResponse({
            totalRequests: 12,
            totalPromptTokens: 100,
            totalCompletionTokens: 50,
            totalCost: 1.5,
          })
        )
      )
    );
    await mount({ providerCount: 2, readyProviderCount: 1 });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("$1.50");
  });
});

describe("overview quota card honesty (U3)", () => {
  it("never renders fake quota data and links to the Quota page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okStatsResponse())));
    await mount({ providerCount: 2, readyProviderCount: 1 });

    expect(container.textContent).not.toContain("No quota data yet");
    expect(container.textContent).toContain("Open quota dashboard →");
    expect(container.textContent).toContain(
      "Per-account limits and reset timers live on the Quota page."
    );
    const quotaLink = container.querySelector('a[href="/dashboard/quota"]');
    expect(quotaLink).not.toBeNull();
    expect(container.textContent).toContain("2 connections");
  });
});
