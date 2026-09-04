// @vitest-environment happy-dom
// D8: a rejected save (400) must surface the server error inside the modal
// instead of failing silently.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AddCustomEmbeddingModal from "@/shared/components/AddCustomEmbeddingModal";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

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

function setInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("add custom embedding save errors (D8)", () => {
  it("shows the server error in-modal on 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: "Name taken" }),
        }),
      ),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        h(AddCustomEmbeddingModal, { isOpen: true, onClose: () => {}, onCreated: () => {} }),
      );
    });

    setInputValue(container.querySelector('input[placeholder="Voyage AI"]'), "dup");
    setInputValue(
      container.querySelector('input[placeholder="https://api.voyageai.com/v1"]'),
      "https://example.com/v1",
    );
    await flush();

    const create = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Create",
    );
    expect(create).not.toBeUndefined();
    create.click();
    await flush();
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("Name taken");
  });
});
