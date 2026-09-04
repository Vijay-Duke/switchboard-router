// @vitest-environment happy-dom
// W8: tool cards with no status payload read "Not detected" (with an
// explanation tooltip), never a bare "Unknown".

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.__React = React;

vi.mock("next/link", () => ({
  default: (props) => {
    const { href, children, ...rest } = props;
    return globalThis.__React.createElement("a", { href, ...rest }, children);
  },
}));

vi.mock("next/image", () => ({
  default: (props) => globalThis.__React.createElement("img", props),
}));

import ToolSummaryCard from "@/app/(dashboard)/dashboard/cli-tools/components/ToolSummaryCard.js";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

async function renderCard(status, toolOverride) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tool = toolOverride || { name: "Cursor", description: "AI editor", color: "#000" };
  await act(async () => {
    root.render(h(ToolSummaryCard, { toolId: "cursor", tool, status }));
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

describe("ToolSummaryCard status wording (W8)", () => {
  it("labels a missing payload Not detected with a config-file explanation", async () => {
    await renderCard(undefined);
    expect(container.textContent).toContain("Not detected");
    expect(container.textContent).not.toContain("Unknown");
    const badge = Array.from(container.querySelectorAll("span")).find((s) =>
      s.textContent === "Not detected",
    );
    expect(badge).toBeDefined();
    expect(badge.getAttribute("title")).toContain("config file");
  });

  it("keeps the Connected label for configured tools", async () => {
    await renderCard({ installed: true, hasSwitchboard: true });
    expect(container.textContent).toContain("Connected");
  });
});

describe("ToolSummaryCard guide-only tools (T89)", () => {
  it("labels guide-configType tools Guide instead of Not detected", async () => {
    await renderCard(undefined, { name: "Codex", description: "guide-only", color: "#000", configType: "guide" });
    expect(container.textContent).toContain("Guide");
    expect(container.textContent).not.toContain("Not detected");
  });

  it("keeps detection labels for configurable tools", async () => {
    await renderCard(undefined, { name: "Cursor", description: "editor", color: "#000", configType: "file" });
    expect(container.textContent).toContain("Not detected");
    expect(container.textContent).not.toContain("Guide");
  });
});
