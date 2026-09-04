// @vitest-environment happy-dom
// Behavioral regression tests (round-2 T110-T111): web page load-failure
// alert + non-JSON error guard, MediaKindTabs video tab + active styling.
// React.createElement (no JSX loader in tests/).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) => h("a", { href: typeof href === "string" ? href : href?.pathname, ...rest }, children),
}));

let pushMock = null;
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: pushMock, replace: () => {}, refresh: () => {} }),
  notFound: () => null,
  usePathname: () => "/dashboard/media-providers/web",
  useSearchParams: () => new URLSearchParams(),
}));

import WebPage from "@/app/(dashboard)/dashboard/media-providers/web/page";
import MediaKindTabs from "@/app/(dashboard)/dashboard/media-providers/MediaKindTabs";
import { useNotificationStore } from "@/store/notificationStore";

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
  pushMock = vi.fn();
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

describe("media-providers web page", () => {
  it("T110: failed load shows an alert with retry; failed non-JSON combo create reports instead of crashing", async () => {
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/combos" && init?.method === "POST") {
        // !ok AND non-JSON body — res.json() must not become an unhandled rejection
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
          headers: { get: () => "text/html" },
        });
      }
      return Promise.resolve(jsonResponse({ error: "boom" }, { ok: false, status: 500 }));
    });

    mount(h(WebPage));
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Couldn't load");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).not.toBeNull();

    // Even with loadFailed, the create-combo path must surface a toast, not a crash.
    const create = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Create"));
    if (create) {
      await act(async () => {
        create.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
      const notes = useNotificationStore.getState().notifications;
      expect(notes.some((n) => String(n.message).includes("Failed to create combo"))).toBe(true);
      expect(container.innerHTML).not.toContain("Application error");
    }
  });
});

describe("MediaKindTabs", () => {
  it("T111: video kind has a tab and active styling marks the current kind", async () => {
    mount(h(MediaKindTabs, { activeKind: "video" }));
    await flush();

    const links = [...container.querySelectorAll("a")];
    const video = links.find((a) => a.getAttribute("href") === "/dashboard/media-providers/video");
    expect(video).not.toBeNull();
    expect(video.textContent).toBe("Video");
    expect(video.className).toContain("bg-brand-500/15");

    const image = links.find((a) => a.getAttribute("href") === "/dashboard/media-providers/image");
    expect(image.className).not.toContain("bg-brand-500/15");
  });
});
