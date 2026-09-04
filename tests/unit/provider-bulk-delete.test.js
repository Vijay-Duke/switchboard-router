// @vitest-environment happy-dom
// D16: bulk delete with a partial server failure must keep the failed rows.

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

describe("provider bulk delete partial failure (D16)", () => {
  it("keeps failed rows and removes only succeeded ones", async () => {
    setProviderId("openai");
    stubPageFetch({
      connections: CONNECTIONS,
      nodes: [{ id: "openai", name: "OpenAI", type: "openai" }],
      routes: {
        "DELETE /api/providers/c1": () => okJson({ ok: true }),
        "DELETE /api/providers/c2": () => errJson(500, { error: "db locked" }),
      },
    });
    harness = mountPage();
    await renderPage(harness);
    const { container } = harness;

    await settle(() => container.textContent.includes("Alpha Conn"), "connections to load");

    // Select both connections via the per-row checkboxes (h-4; the
    // header "Select All" box is h-3.5).
    await act(async () => {
      const rows = container.querySelectorAll('input[type="checkbox"].h-4');
      expect(rows.length).toBe(2);
      for (const box of rows) {
        click(box);
      }
    });
    await settle(
      () => container.textContent.includes("Delete Selected (2)"),
      "bulk delete button",
    );

    // Confirm the bulk delete.
    await act(async () => {
      const bulk = [...container.querySelectorAll("button")].find((b) =>
        b.textContent.includes("Delete Selected (2)"),
      );
      click(bulk);
    });
    await settle(
      () => container.textContent.includes("Delete 2 Connections"),
      "confirm dialog",
    );
    await act(async () => {
      const confirm = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Confirm",
      );
      click(confirm);
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle(
      () => errorToasts().length > 0 || !container.textContent.includes("Alpha Conn"),
      "bulk delete to settle",
    );

    // c1 deleted, c2 (failed) still listed.
    expect(container.textContent).not.toContain("Alpha Conn");
    expect(container.textContent).toContain("Beta Conn");
    expect(errorToasts().some((n) => n.message.includes("1 failed"))).toBe(true);
  });
});
