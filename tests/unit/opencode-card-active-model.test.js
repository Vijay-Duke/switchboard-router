// @vitest-environment happy-dom
// T81/T82/T84 behavioral tests for OpenCodeToolCard: closing the Add Model
// modal must not silently re-POST settings (T81), clicking a chip sets the
// active model locally and a later status refresh must not revert it (T82),
// and the subagent placeholder mirrors the active model now that the dead
// selectedModel state is gone (T84). React.createElement, no JSX.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

import OpenCodeToolCard from "@/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard";

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Server state: two models, active glm/a. Later refreshes still say glm/a —
// the card must keep a locally changed active model (T82).
const STATUS = {
  installed: true,
  hasSwitchboard: true,
  config: { provider: { switchboard: { options: { baseURL: "http://localhost:20128/v1" } } } },
  opencode: { models: ["glm/a", "glm/b"], activeModel: "glm/a" },
};

const props = {
  tool: { name: "OpenCode", description: "opencode", image: "/x.png" },
  isExpanded: true,
  onToggle: () => {},
  baseUrl: "http://localhost:20128",
  apiKeys: [],
  activeProviders: [{ id: "c1", provider: "glm", name: "GLM" }],
  cloudEnabled: false,
  initialStatus: STATUS,
};

let root = null;
let container = null;
let calls = [];

function jsonOk(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function installFetch() {
  const impl = async (url, init) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url === "/api/cli-tools/opencode-settings" && !init?.method) return jsonOk(STATUS);
    if (url === "/api/cli-tools/opencode-settings") return jsonOk({ ok: true });
    if (url === "/api/models/alias") return jsonOk({ aliases: {} });
    if (url === "/api/combos") return jsonOk([]);
    if (url === "/api/provider-nodes") return jsonOk([]);
    if (url === "/api/models/custom") return jsonOk([]);
    if (url === "/api/models/disabled") return jsonOk({});
    if (url === "/api/v1/models") return jsonOk({ data: [] });
    return jsonOk({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(QueryClientProvider, { client: new QueryClient() }, h(OpenCodeToolCard, props)));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

const findButton = (label) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent.includes(label));

const pressEscape = () =>
  act(() => {
    (document.activeElement || document).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  calls = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenCodeToolCard active model (T81/T82/T84)", () => {
  it("T81: closing the Add Model modal never POSTs settings", async () => {
    installFetch();
    await mount();
    const postsBefore = calls.filter((c) => c.startsWith("POST")).length;
    act(() => findButton("Add Model").click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    pressEscape();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const postsAfter = calls.filter((c) => c.startsWith("POST")).length;
    expect(postsAfter).toBe(postsBefore);
  });

  it("T82: clicking a chip sets active locally; a status refresh must not revert it", async () => {
    installFetch();
    await mount();
    expect(container.textContent).toContain("Active: glm/a");
    // Click chip glm/b (aria-pressed toggle button)
    const chipB = Array.from(container.querySelectorAll('button[aria-pressed]')).find(
      (b) => b.textContent.includes("glm/b")
    );
    await act(async () => chipB.click());
    expect(container.textContent).toContain("Active: glm/b");
    // Refresh status (remove glm/b? no — trigger checkStatus via Reset-free path:
    // removing a model DELETEs and refreshes). Instead re-mount flush: simulate
    // the periodic checkStatus by forcing the refresh the card runs after DELETE.
    // Simplest observable: removing model glm/b would clear active; removing glm/a
    // must keep active glm/b.
    const removeA = Array.from(container.querySelectorAll('button[aria-label]')).find(
      (b) => b.getAttribute("aria-label") === "Remove glm/a"
    );
    await act(async () => removeA.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    // GET after DELETE re-delivers STATUS (server still lists glm/a + active glm/a);
    // the card must not revert local state back to glm/a.
    expect(container.textContent).toContain("Active: glm/b");
  });

  it("T84: subagent placeholder mirrors the active model, not dead selectedModel state", async () => {
    installFetch();
    await mount();
    const chipB = Array.from(container.querySelectorAll('button[aria-pressed]')).find(
      (b) => b.textContent.includes("glm/b")
    );
    await act(async () => chipB.click());
    const subagentInput = container.querySelector('input[placeholder*="provider/model-id"], input[placeholder^="glm/"]');
    expect(subagentInput).not.toBeNull();
    expect(subagentInput.getAttribute("placeholder")).toBe("glm/b");
  });
});
