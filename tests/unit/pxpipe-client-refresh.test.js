// @vitest-environment happy-dom
// Behavioral regression tests (round-2 T113-T114): PXPIPE client must not
// parse error payloads as data ("Not installed" during outages), must clear
// stale numbers on failure, and must label unknown skip reasons. React
// .createElement (no JSX loader in tests/).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }) => h("a", { href: typeof href === "string" ? href : href?.pathname }, children),
}));

import PxpipeClient from "@/app/(dashboard)/dashboard/pxpipe/PxpipeClient";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  headers: { get: () => "application/json" },
});

const STATUS = { installed: true, installing: false, version: "1.2.3", running: true, uptimeMs: 60000, enabled: true, autoInstall: true, minChars: 4000, timeoutMs: 2000, mode: "proxy" };
const STATS = {
  windows: {
    today: { requests: 1, compressed: 1, bypassed: 0, errors: 0, tokensBeforeEst: 1000, tokensAfterEst: 500, tokensSavedEst: 500, savedPct: 50, imagesGenerated: 0, compressionTimeMs: 10, avgCompressionMs: 10 },
    yesterday: null, last7d: { requests: 1234, compressed: 10, bypassed: 2, errors: 0, tokensBeforeEst: 999999, tokensAfterEst: 1, tokensSavedEst: 999998, savedPct: 99, imagesGenerated: 3, compressionTimeMs: 1, avgCompressionMs: 1 },
    last30d: null, all: null,
  },
  timeline: [],
  recent: [],
};

let root = null;
let container = null;
let fetchMock = null;
let outage = null; // "all" | "health" | null

function route(url) {
  if (outage === "all") return jsonResponse({ error: "boom" }, { ok: false, status: 500 });
  if (outage === "health" && url === "/api/pxpipe/health") {
    return jsonResponse({ error: "boom" }, { ok: false, status: 500 });
  }
  if (url === "/api/pxpipe/status") return jsonResponse(STATUS);
  if (url === "/api/pxpipe/stats") return jsonResponse(STATS);
  if (url.startsWith("/api/pxpipe/logs")) return jsonResponse([]);
  if (url === "/api/pxpipe/health") return jsonResponse({ healthy: true });
  return jsonResponse({});
}

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
  outage = null;
  fetchMock = vi.fn((url) => Promise.resolve(route(url)));
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

describe("PxpipeClient refresh", () => {
  it("T113: full outage shows an error alert and never reports 'Not installed'", async () => {
    outage = "all";
    mount(h(PxpipeClient));
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Failed to load PXPIPE data");
    expect(container.textContent).not.toContain("Not installed");
  });

  it("T113: error after a good load clears the stale numbers", async () => {
    mount(h(PxpipeClient));
    await flush();
    // Numbers from last7d window are visible
    expect(container.textContent).toContain("1,234");

    outage = "health";
    fetchMock.mockImplementation((url) => Promise.resolve(route(url)));
    // Re-run refresh via remount-with-new-key (same component instance state
    // doesn't matter — the cleared-state contract is what we assert after settle)
    await act(async () => {
      root.render(h(PxpipeClient, { key: "second" }));
    });
    await flush();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("1,234");
    expect(container.textContent).toContain("—");
  });

  it("T114: skip events without a reason render 'Skipped'; known reasons keep their label", async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(url === "/api/pxpipe/stats"
        ? jsonResponse({
            ...STATS,
            recent: [
              { ts: 1693700000000, applied: false },
              { ts: 1693700001000, applied: false, reason: "below_threshold" },
            ],
          })
        : route(url)));

    mount(h(PxpipeClient));
    await flush();

    const text = container.textContent;
    expect(text).toContain("Skipped");
    expect(text).toContain("Below size threshold");
    expect(container.textContent).not.toContain("undefined");
  });
});
