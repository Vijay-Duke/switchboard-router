// @vitest-environment happy-dom
// D6: the availability badge button must render (it was commented out) and
// toggle the popover; unhealthy payloads show the issue count.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ModelAvailabilityBadge from "@/app/(dashboard)/dashboard/providers/components/ModelAvailabilityBadge";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

async function mount(payload) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }),
    ),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(ModelAvailabilityBadge, null));
  });
}

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

describe("model availability badge (D6)", () => {
  it("renders the healthy badge button and opens the popover on click", async () => {
    await mount({ models: [], unavailableCount: 0 });

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("All models operational"),
    );
    expect(button).not.toBeUndefined();

    await act(async () => {
      button.click();
    });
    expect(container.textContent).toContain("Model Status");
    expect(container.textContent).toContain("All models are responding normally.");
  });

  it("shows the issue count for an unhealthy payload", async () => {
    await mount({
      models: [{ provider: "openai", model: "gpt-4", status: "cooldown" }],
      unavailableCount: 1,
    });

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("1 model with issues"),
    );
    expect(button).not.toBeUndefined();

    await act(async () => {
      button.click();
    });
    expect(container.textContent).toContain("gpt-4");
  });
});
