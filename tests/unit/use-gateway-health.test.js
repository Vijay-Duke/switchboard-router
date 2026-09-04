// @vitest-environment happy-dom
// U9/W15: useGatewayHealth resolves online:false when /api/health rejects
// (and online:false on non-2xx, online:true on ok), and all mounters share
// one module-level poll. Each test imports a fresh module so shared state
// never leaks between cases. Follows the repo's react-dom + act + happy-dom
// style (no @testing-library installed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let useGatewayHealth;
let roots = [];
let containers = [];
let seen = [];

function Probe({ intervalMs }) {
  const { online } = useGatewayHealth({ intervalMs });
  seen.push(online);
  return null;
}

function setHidden(hidden) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

async function mountProbe(intervalMs = 30000) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(Probe, { intervalMs }));
  });
  return root;
}

async function renderProbe(fetchImpl, { hidden = false } = {}) {
  globalThis.fetch = vi.fn(fetchImpl);
  setHidden(hidden);
  await mountProbe();
  return seen[seen.length - 1];
}

async function unmountAll() {
  await act(async () => {
    while (roots.length) roots.pop().unmount();
  });
  while (containers.length) containers.pop().remove();
}

beforeEach(async () => {
  vi.resetModules();
  ({ useGatewayHealth } = await import("@/shared/hooks/useGatewayHealth"));
  seen = [];
});

afterEach(async () => {
  await unmountAll();
  setHidden(false);
  vi.useRealTimers();
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
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe("useGatewayHealth shared poll (W15)", () => {
  it("two mounters share one in-flight probe and both receive the result", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    setHidden(false);
    const values = [];
    function Reader() {
      values.push(useGatewayHealth({ intervalMs: 30000 }).online);
      return null;
    }
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.appendChild(a);
    document.body.appendChild(b);
    containers.push(a, b);
    const rootA = createRoot(a);
    const rootB = createRoot(b);
    roots.push(rootA, rootB);
    await act(async () => {
      rootA.render(h(Reader));
      rootB.render(h(Reader));
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // Last render of each reader saw the shared offline value.
    expect(values.slice(-2)).toEqual([false, false]);
  });

  it("runs one interval for all mounters and clears it when the last one leaves", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    setHidden(false);
    const rootA = await mountProbe(30000);
    await mountProbe(30000);
    // Sequential mounts each probe once on mount (no in-flight overlap here).
    const base = globalThis.fetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(base + 1);

    // First subscriber leaves: the poll keeps running for the second.
    await act(async () => {
      rootA.unmount();
    });
    roots.splice(roots.indexOf(rootA), 1);
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(base + 2);

    // Last subscriber leaves: interval and visibility listener are gone.
    await unmountAll();
    await act(async () => {
      vi.advanceTimersByTime(90000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(base + 2);
  });

  it("late mounters start from the last known value", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    setHidden(false);
    await mountProbe();
    expect(seen[seen.length - 1]).toBe(false);
    seen = [];
    await mountProbe();
    // First render of the late mounter already reads the shared offline state.
    expect(seen[0]).toBe(false);
  });
});
