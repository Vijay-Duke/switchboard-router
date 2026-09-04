// @vitest-environment happy-dom
// D18: a rejected node update (PUT 400) must surface an error toast and keep
// the edit modal open.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  click,
  errJson,
  errorToasts,
  mountPage,
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

describe("provider node update failure (D18)", () => {
  it("toasts the server error and leaves the modal open on 400", async () => {
    setProviderId("openai-compatible-test");
    stubPageFetch({
      connections: [],
      nodes: [
        {
          id: "openai-compatible-test",
          name: "Test Node",
          type: "openai-compatible",
          baseUrl: "https://example.com/v1",
          apiType: "chat",
        },
      ],
      routes: {
        "PUT /api/provider-nodes/openai-compatible-test": () =>
          errJson(400, { error: "bad baseUrl" }),
      },
    });
    harness = mountPage();
    await renderPage(harness);
    const { container } = harness;

    await settle(
      () => container.textContent.includes("OpenAI Compatible Details"),
      "node details card",
    );

    // Open the node edit modal (Button prepends its icon name: "editEdit").
    await act(async () => {
      const edits = [...container.querySelectorAll("button")].filter((b) =>
        b.textContent.endsWith("Edit"),
      );
      expect(edits).toHaveLength(1);
      click(edits[0]);
    });
    await settle(() => container.textContent.includes("Save"), "edit modal");

    // Submit; the server rejects.
    await act(async () => {
      const save = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Save",
      );
      expect(save).not.toBeUndefined();
      click(save);
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle(() => errorToasts().length > 0, "error toast");

    expect(errorToasts().some((n) => n.message.includes("bad baseUrl"))).toBe(true);
    // Modal stays open (Save still rendered inside a dialog).
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "Save"),
    ).toBe(true);
  });
});
