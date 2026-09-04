// @vitest-environment happy-dom
// D4: closing the Kiro modals must reset auth state so reopening starts at
// fresh method selection (the components stay mounted while closed).

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import KiroAuthModal from "@/shared/components/KiroAuthModal";
import KiroOAuthWrapper from "@/shared/components/KiroOAuthWrapper";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/shared/components/OAuthModal", () => ({
  default: () => null,
}));

vi.mock("@/shared/components/KiroSocialOAuthModal", () => ({
  default: () => null,
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

async function mount(el) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
}

async function rerender(el) {
  await act(async () => {
    root.render(el);
  });
}

function setInputValue(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function clickButtonWithText(text) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent.includes(text),
  );
  expect(button, `button containing "${text}"`).not.toBeUndefined();
  button.click();
}

describe("kiro auth modal reset on close (D4)", () => {
  it("clears method, inputs and errors after close/reopen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
    );
    const props = { isOpen: true, onMethodSelect: () => {}, onClose: () => {} };
    await mount(h(KiroAuthModal, props));

    // Drill into the API-key form and leave state behind.
    await act(async () => {
      clickButtonWithText("API Key");
    });
    setInputValue(container.querySelector('input[placeholder="Paste your Kiro API key..."]'), "stale");
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Choose your authentication method:");

    await rerender(h(KiroAuthModal, { ...props, isOpen: false }));
    await rerender(h(KiroAuthModal, { ...props, isOpen: true }));

    expect(container.textContent).toContain("Choose your authentication method:");
    expect(container.querySelector('input[placeholder="Paste your Kiro API key..."]')).toBeNull();
  });

  it("wrapper returns to method selection after close/reopen", async () => {
    const props = { isOpen: true, onSuccess: () => {}, onClose: () => {} };
    await mount(h(KiroOAuthWrapper, props));

    // Builder ID jumps straight into the device sub-flow (stubbed null).
    await act(async () => {
      clickButtonWithText("AWS Builder ID");
    });
    expect(container.textContent).not.toContain("Choose your authentication method:");

    await rerender(h(KiroOAuthWrapper, { ...props, isOpen: false }));
    await rerender(h(KiroOAuthWrapper, { ...props, isOpen: true }));

    expect(container.textContent).toContain("Choose your authentication method:");
  });
});
