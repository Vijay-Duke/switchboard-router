// @vitest-environment happy-dom
// U9: useGatewayHealth resolves online:false when /api/health rejects (and
// online:false on non-2xx, online:true on ok). Follows the repo's
// react-dom + act + happy-dom style (no @testing-library installed).

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useGatewayHealth } from "@/shared/hooks/useGatewayHealth";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;
let seen = [];

function Probe({ intervalMs }) {
  const { online } = useGatewayHealth({ intervalMs });
  seen.push(online);
  return null;
}

async function renderProbe(fetchImpl, { hidden = false } = {}) {
  seen = [];
  globalThis.fetch = vi.fn(fetchImpl);
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(Probe, { intervalMs: 30000 }));
  });
  return seen[seen.length - 1];
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useGatewayHealth (U9)", () => {
  it("resolves online:false when the health probe rejects", async () => {
    const online = await renderProbe(async () => {
      throw new Error("connection refused");
    });
    expect(online).toBe(false);
  });

  it("resolves online:false on a non-ok response", async () => {
    const online = await renderProbe(async () => ({ ok: false }));
    expect(online).toBe(false);
  });

  it("resolves online:true when the probe succeeds", async () => {
    const online = await renderProbe(async () => ({ ok: true }));
    expect(online).toBe(true);
  });

  it("skips the probe while the tab is hidden", async () => {
    const online = await renderProbe(
      async () => {
        throw new Error("must not be called while hidden");
      },
      { hidden: true }
    );
    expect(online).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("re-probes immediately when the tab becomes visible again", async () => {
    await renderProbe(async () => ({ ok: false }), { hidden: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toBe(false);
  });
});
