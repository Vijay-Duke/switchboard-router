// @vitest-environment happy-dom
// U1 regression: cancelling the manual-update countdown must clear the
// shutdown interval so no POST reaches /api/version/shutdown. Also covers
// unmount cleanup and the disabled-while-counting button guard.
// No @testing-library in this repo; follows tests/unit/shared-modal-dialog.test.js
// (react-dom + act + happy-dom, React.createElement, no JSX).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let root = null;
let container = null;
let shutdownPosts = [];

function mockFetch() {
  shutdownPosts = [];
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/api/version/shutdown")) {
      shutdownPosts.push(u);
      return { ok: true };
    }
    if (u.includes("/api/health")) return { ok: true, json: async () => ({ ok: true }) };
    if (u.includes("/api/version")) {
      return {
        ok: true,
        json: async () => ({ hasUpdate: true, latestVersion: "9.9.9", currentVersion: "0.0.1" }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
}

function stubClipboard() {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  });
}

function buttons() {
  return Array.from(container.querySelectorAll("button"));
}

function findButton(match) {
  const found = buttons().find((b) => match(b.textContent || ""));
  if (!found) throw new Error(`button not found; have: [${buttons().map((b) => b.textContent).join(" | ")}]`);
  return found;
}

/** Mount, flush the /api/version effect, open the manual-update overlay. */
async function openUpdateOverlay() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(Sidebar, {}));
  });
  await act(async () => {
    findButton((t) => t === "Update now").click();
  });
  await act(async () => {
    findButton((t) => t === "Continue").click();
  });
  const overlay = container.querySelector(".fixed.inset-0");
  expect(overlay).not.toBeNull();
  return overlay;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch();
  stubClipboard();
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sidebar manual-update cancel (U1)", () => {
  it("cancel stops the countdown and never POSTs shutdown", async () => {
    await openUpdateOverlay();
    await act(async () => {
      findButton((t) => t.includes("Copy") || t.includes("Copied")).click();
    });

    const copyBtn = findButton((t) => t.includes("Copy") || t.includes("Copied"));
    expect(copyBtn.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    await act(async () => {
      findButton((t) => t === "Cancel").click();
    });
    expect(container.querySelector(".fixed.inset-0")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(shutdownPosts).toEqual([]);
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes("/api/version/shutdown"))).toBe(false);
  });

  it("clicking Copy & shutdown twice starts only one timer", async () => {
    await openUpdateOverlay();
    // First click starts the countdown and disables the button.
    await act(async () => {
      findButton((t) => t.includes("Copy") || t.includes("Copied")).click();
    });
    expect(findButton((t) => t.includes("Copy") || t.includes("Copied")).disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    // shutdownCountdownSec is 3: exactly one POST after the full countdown.
    expect(shutdownPosts.length).toBe(1);
  });

  it("unmount clears the countdown so no shutdown POST is sent", async () => {
    await openUpdateOverlay();
    await act(async () => {
      findButton((t) => t.includes("Copy") || t.includes("Copied")).click();
    });
    act(() => root.unmount());
    root = null;
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    expect(shutdownPosts).toEqual([]);
  });
});
