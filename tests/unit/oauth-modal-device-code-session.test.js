// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import OAuthModal from "@/shared/components/OAuthModal";

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function render(isOpen) {
  await act(async () => {
    root.render(h(OAuthModal, {
      isOpen,
      provider: "github",
      providerInfo: { name: "GitHub" },
      onClose: () => {},
    }));
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth modal device-code sessions", () => {
  it("ignores a device-code response from a closed session after reopening", async () => {
    const first = deferred();
    const second = deferred();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "open").mockImplementation(() => null);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await render(true);
    await render(false);
    await render(true);

    await act(async () => {
      first.resolve({
        ok: true,
        json: async () => ({
          device_code: "stale-device",
          user_code: "STALE",
          verification_uri: "https://example.test/device",
          interval: 1,
        }),
      });
      await first.promise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/poll"))).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  });
});
