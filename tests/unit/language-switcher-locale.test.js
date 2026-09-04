// @vitest-environment happy-dom
// O32: a controlled LanguageSwitcher must close with the locale the user just
// picked, not the previous one, so the parent's flag never flashes stale.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/i18n/runtime", () => ({
  reloadTranslations: () => Promise.resolve(),
}));

let root = null;
let container = null;

afterEach(() => {
  if (root) act(() => root.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("LanguageSwitcher controlled close (O32)", () => {
  it("passes the newly chosen locale to onClose", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true })));
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(LanguageSwitcher, { isOpen: true, onClose, hideTrigger: true }));
    });

    const zh = document.querySelector('button[title="简体中文"]');
    expect(zh).toBeTruthy();
    await act(async () => {
      zh.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("zh-CN");
  });
});
