// @vitest-environment happy-dom
// D9: copy() resolves false when the clipboard write fails, and
// ManualConfigModal never shows a false "Copied!".

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import ManualConfigModal from "@/shared/components/ManualConfigModal";
import { useNotificationStore } from "@/store/notificationStore";

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
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function denyClipboard() {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    configurable: true,
  });
}

describe("copy-to-clipboard failure (D9)", () => {
  it("copy() resolves false and leaves copied unset when the write rejects", async () => {
    denyClipboard();
    let result;
    let seen;
    function Probe() {
      const { copied, copy } = useCopyToClipboard(10);
      seen = copied;
      result = copy("x", "probe");
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(h(Probe, null));
    });
    await expect(result).resolves.toBe(false);
    expect(seen).toBeNull();
  });

  it("manual config shows no Copied! UI and toasts on clipboard denial", async () => {
    denyClipboard();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        h(ManualConfigModal, {
          isOpen: true,
          onClose: () => {},
          configs: [{ filename: "a.json", content: "{}" }],
        }),
      );
    });

    const copyButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Copy"),
    );
    await act(async () => {
      copyButton.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).not.toContain("Copied!");
    const errors = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "error");
    expect(errors.length).toBeGreaterThan(0);
  });
});
