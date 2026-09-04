// @vitest-environment happy-dom
// D7: with an empty changelogUrl the modal must not fetch and must show the
// "not configured" message (mirrors DonateModal).

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ChangelogModal from "@/shared/components/ChangelogModal";
import { GITHUB_CONFIG } from "@/shared/constants/config";

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

describe("changelog modal empty-url guard (D7)", () => {
  it("issues no fetch and shows not-configured when changelogUrl is empty", async () => {
    expect(GITHUB_CONFIG.changelogUrl).toBe("");
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("# x") }),
    );
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(h(ChangelogModal, { isOpen: true, onClose: () => {} }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("not configured");
  });
});
