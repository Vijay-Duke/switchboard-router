// @vitest-environment happy-dom
// D3: the CLIProxyAPI import success call ("import-cli-proxy") must reach
// onSuccess just like the plain "import" path.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import KiroOAuthWrapper from "@/shared/components/KiroOAuthWrapper";

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

function stubFetch(handler) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

function okJson(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function setTextValue(el, value) {
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function clickButtonWithHeading(text) {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent.includes(text),
  );
  expect(button, `button containing "${text}"`).not.toBeUndefined();
  button.click();
}

async function mount(onSuccess) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(KiroOAuthWrapper, { isOpen: true, onSuccess, onClose: () => {} }));
  });
}

describe("kiro wrapper method select (D3)", () => {
  it("calls onSuccess once after CLIProxyAPI import succeeds", async () => {
    stubFetch((url) => {
      if (String(url).includes("import-cli-proxy")) return Promise.resolve(okJson({ ok: true }));
      return Promise.resolve(okJson({}));
    });
    const onSuccess = vi.fn();
    await mount(onSuccess);

    await act(async () => {
      clickButtonWithHeading("Import CLIProxyAPI JSON");
    });
    setTextValue(container.querySelector("textarea"), '{"auth_method":"external_idp"}');
    await flush();

    await act(async () => {
      clickButtonWithHeading("Import CLIProxyAPI JSON");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("still calls onSuccess after plain token import", async () => {
    stubFetch((url) => {
      if (String(url).includes("auto-import")) return Promise.resolve(okJson({ found: false }));
      if (String(url).includes("/import")) return Promise.resolve(okJson({ ok: true }));
      return Promise.resolve(okJson({}));
    });
    const onSuccess = vi.fn();
    await mount(onSuccess);

    await act(async () => {
      clickButtonWithHeading("Import Token");
    });
    await flush();
    setTextValue(container.querySelector('input[placeholder="Token will be auto-filled..."]'), "rt");
    await flush();

    await act(async () => {
      clickButtonWithHeading("Import Token");
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
