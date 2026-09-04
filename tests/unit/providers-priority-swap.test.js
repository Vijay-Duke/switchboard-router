// @vitest-environment happy-dom
// D17: a failed priority swap (500 on either PUT) must revert the optimistic
// order and surface an error.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  click,
  errJson,
  errorToasts,
  mountPage,
  okJson,
  setProviderId,
  renderPage,
  settle,
  stubPageFetch,
  unmountPage,
} from "./provider-detail-harness";

let harness = null;

afterEach(() => {
  if (harness) {
    unmountPage(harness);
    harness = null;
  }
});

const CONNECTIONS = [
  { id: "c1", provider: "openai", authType: "apikey", name: "Alpha Conn", testStatus: "active", isActive: true, priority: 0 },
  { id: "c2", provider: "openai", authType: "apikey", name: "Beta Conn", testStatus: "active", isActive: true, priority: 1 },
];

function order(container) {
  return [
    container.textContent.indexOf("Alpha Conn"),
    container.textContent.indexOf("Beta Conn"),
  ];
}

describe("provider priority swap failure (D17)", () => {
  it("reverts the optimistic order and toasts when the second PUT 500s", async () => {
    setProviderId("openai");
    // Gate the PUTs so the optimistic render is observable before the
    // failure revert lands.
    let releasePut;
    const putGate = new Promise((resolve) => {
      releasePut = resolve;
    });
    stubPageFetch({
      connections: CONNECTIONS,
      nodes: [{ id: "openai", name: "OpenAI", type: "openai" }],
      routes: {
        // First PUT (c2 -> priority 1) succeeds, second (c1 -> priority 0) fails.
        "PUT *": async (u) => {
          await putGate;
          return u.endsWith("/api/providers/c1")
            ? errJson(500, { error: "boom" })
            : okJson({ ok: true });
        },
      },
    });
    harness = mountPage();
    await renderPage(harness);
    const { container } = harness;

    await settle(() => container.textContent.includes("Beta Conn"), "connections to load");
    const [a0, b0] = order(container);
    expect(a0).toBeGreaterThan(-1);
    expect(a0).toBeLessThan(b0);

    // Move Beta up: optimistic order becomes Beta, Alpha.
    await act(async () => {
      const up = container.querySelector('[aria-label="Move Beta Conn up"]');
      expect(up).not.toBeNull();
      click(up);
    });
    await settle(() => {
      const [a, b] = order(container);
      return b > -1 && b < a;
    }, "optimistic swap");

    // Release the PUTs; the 500 reverts to Alpha, Beta plus an error toast.
    await act(async () => {
      releasePut();
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle(
      () => {
        const [a, b] = order(container);
        return a > -1 && a < b && errorToasts().length > 0;
      },
      "order revert + error toast",
    );
  });
});
