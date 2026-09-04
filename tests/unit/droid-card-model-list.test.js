// @vitest-environment happy-dom
// T52/T53 behavioral tests for DroidToolCard's multi-model list: the Add
// Models modal must stay open for a second selection (T52), and malformed
// settings entries (missing/blank model) must not produce blank chips (T53).

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

import DroidToolCard from "@/app/(dashboard)/dashboard/cli-tools/components/DroidToolCard";

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
  installed: true,
  hasSwitchboard: true,
  settings: {
    customModels: [
      { id: "custom:Switchboard-0", model: "glm/one", index: 0 },
      { id: "custom:Switchboard-1", model: "glm/two", index: 1 },
      { id: "custom:Switchboard-2", model: null, index: 2 },
      { id: "custom:Switchboard-3", model: "   ", index: 3 },
      { id: "other:Model-9", model: "glm/foreign", index: 4 },
    ],
  },
};

const props = {
  tool: { name: "Droid", description: "factory droid" },
  hasActiveProviders: true,
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

function jsonOk(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function installFetch() {
  const impl = async (url) => {
    if (url === "/api/cli-tools/droid-settings") return jsonOk(STATUS);
    if (url === "/api/models/alias") return jsonOk({ aliases: {} });
    if (url === "/api/combos") return jsonOk([]);
    if (url === "/api/provider-nodes") return jsonOk([]);
    if (url === "/api/models/custom") return jsonOk([]);
    if (url === "/api/models/disabled") return jsonOk({});
    if (url === "/api/v1/models") return jsonOk({ data: [{ id: "glm/glm-5.3", name: "glm-5.3" }, { id: "glm/glm-5.2", name: "glm-5.2" }] });
    return jsonOk({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(h(QueryClientProvider, { client: new QueryClient() }, h(DroidToolCard, props)));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

const findButton = (label) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent.includes(label));

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

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

describe("DroidToolCard model list (T52/T53)", () => {
  it("T53: malformed entries never become blank chips", async () => {
    installFetch();
    await mount();
    const text = container.textContent;
    expect(text).toContain("glm/one");
    expect(text).toContain("glm/two");
    expect(text).not.toContain("glm/foreign");
    // A blank chip renders as an empty inline-flex span with just a close button.
    const chips = Array.from(container.querySelectorAll("span.inline-flex")).map((s) => s.textContent);
    expect(chips.filter((t) => t.replace("close", "").trim() === "")).toHaveLength(0);
  });

  it("T52: two models can be added in one modal session", async () => {
    installFetch();
    await mount();
    act(() => findButton("Select").click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const rows = Array.from(dialog.querySelectorAll("button")).filter((b) => /glm-5/.test(b.textContent));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await act(async () => rows[0].click());
    await settle();
    // Modal stays open for closeOnSelect=false (T52 regression: closing after one).
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const rows2 = Array.from(document.querySelector('[role="dialog"]').querySelectorAll("button")).filter((b) => /glm-5/.test(b.textContent));
    await act(async () => rows2[1].click());
    await settle();
    const text = container.textContent;
    expect(text).toContain("glm/one");
    expect(text).toContain("glm/two");
    expect((text.match(/glm-5\./g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
