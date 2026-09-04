// @vitest-environment happy-dom
// W12: the MITM "Switchboard Base URL" defaults to a 127.0.0.1 origin-derived
// URL, never localhost.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import MitmServerCard from "@/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

async function renderCard() {
  globalThis.fetch = vi.fn(async () => ({ ok: false }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(MitmServerCard, { apiKeys: [], cloudEnabled: false }));
  });
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("MitmServerCard default base URL (W12)", () => {
  it("defaults to a 127.0.0.1 URL, not localhost", async () => {
    await renderCard();
    const input = container.querySelector("#mitm-router-base-url");
    expect(input).not.toBeNull();
    expect(input.value).toContain("127.0.0.1");
    expect(input.value).not.toContain("localhost");
  });
});
