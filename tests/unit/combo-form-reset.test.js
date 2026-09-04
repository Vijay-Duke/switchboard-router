// @vitest-environment happy-dom
// D10: the create draft (name/models) must reset on open and after save.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ComboFormModal from "@/shared/components/ComboFormModal";
import QueryProvider from "@/shared/query/QueryProvider";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

function stubAlias() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
  );
}

function setInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function renderModal(props) {
  await act(async () => {
    root.render(h(QueryProvider, null, h(ComboFormModal, props)));
  });
}

function nameInput() {
  return container.querySelector('input[placeholder="my-combo"]');
}

describe("combo form draft reset (D10)", () => {
  it("clears a typed name after close and reopen", async () => {
    stubAlias();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const base = { combo: null, onClose: () => {}, onSave: async () => {}, activeProviders: [] };

    await renderModal({ ...base, isOpen: true });
    setInputValue(nameInput(), "my-draft");
    await act(async () => {
      await Promise.resolve();
    });
    expect(nameInput().value).toBe("my-draft");

    await renderModal({ ...base, isOpen: false });
    await renderModal({ ...base, isOpen: true });
    expect(nameInput().value).toBe("");
    expect(container.textContent).toContain("No models added yet");
  });
});
