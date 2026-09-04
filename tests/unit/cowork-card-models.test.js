// @vitest-environment happy-dom
// T43-T46 behavioral tests for CoworkToolCard: the Add Model path must add
// models that survive Apply (T43), local edits must not be reverted by the
// status refresh that follows Apply (T44), a keyless local-mode Apply must
// post the sk_switchboard default (T45), and Apply must never post an empty
// baseUrl (T46). React.createElement (no JSX), per repo test convention.

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

import CoworkToolCard from "@/app/(dashboard)/dashboard/cli-tools/components/CoworkToolCard";

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
  installed: true,
  hasSwitchboard: true,
  cowork: {
    baseUrl: "http://localhost:20128/v1",
    plugins: [],
    localPlugins: [],
    models: ["glm/old", "glm/keep"],
  },
  defaultPlugins: [],
};

const props = {
  tool: { name: "Cowork", description: "Claude Cowork", image: "/x.png" },
  isExpanded: true,
  onToggle: () => {},
  baseUrl: "http://localhost:20128",
  apiKeys: [],
  activeProviders: [{ id: "c1", provider: "glm", name: "GLM" }],
  hasActiveProviders: true,
  cloudEnabled: false,
};

let root = null;
let container = null;
let posts = [];
let statusEcho = STATUS;

function jsonOk(data) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

function installFetch() {
  const impl = async (url, init) => {
    if (url === "/api/cli-tools/cowork-settings" && init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return jsonOk({ ok: true });
    }
    if (url === "/api/cli-tools/cowork-settings") return jsonOk(statusEcho);
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

async function mount(cardProps = props) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      h(QueryClientProvider, { client: new QueryClient() }, h(CoworkToolCard, cardProps))
    );
  });
  // Flush the mount-time status fetch so chips/messages settle inside act.
  await act(async () => { await Promise.resolve(); });
}

const findButton = (label) =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent.includes(label)
  );

const removeChip = (name) => {
  // chips render [name][x-button] inside a span.inline-flex
  const chipSpan = Array.from(container.querySelectorAll("span.inline-flex")).find((s) =>
    s.textContent.includes(name)
  );
  act(() => {
    chipSpan.querySelector("button").click();
  });
};

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  posts = [];
  statusEcho = STATUS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoworkToolCard models (T43/T44/T45/T46)", () => {
  it("T43: Add Model opens the modal, selection becomes a chip, Apply posts it", async () => {
    installFetch();
    await mount();
    act(() => findButton("Add Model").click());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const row = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /glm-5\.3/.test(b.textContent)
    );
    expect(row).toBeDefined();
    await act(async () => row.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(container.textContent).toContain("glm/glm-5.3");
    await act(async () => findButton("Apply").click());
    const post = posts.at(-1);
    expect(post.models.some((m) => /^glm\/glm-5\.\d$/.test(m) || m.includes("glm-5.3"))).toBe(true);
  });

  it("T44: a removed model stays removed across the status refresh triggered by Apply", async () => {
    installFetch();
    await mount();
    expect(container.textContent).toContain("glm/old");
    removeChip("glm/old");
    expect(container.textContent).not.toContain("glm/old");
    // statusEcho still lists glm/old — server state must not resurrect the chip.
    await act(async () => findButton("Apply").click());
    expect(container.textContent).not.toContain("glm/old");
    expect(posts.at(-1).models).not.toContain("glm/old");
  });

  it("T45: keyless local mode applies with the sk_switchboard default key", async () => {
    installFetch();
    await mount({ ...props, cloudEnabled: false, apiKeys: [] });
    await act(async () => findButton("Apply").click());
    expect(posts.at(-1).apiKey).toBe("sk_switchboard");
  });

  it("T46: Apply never posts an empty baseUrl — falls back to the local URL", async () => {
    installFetch();
    // Server knows no endpoint: nothing seeds the custom field.
    statusEcho = { ...STATUS, cowork: { ...STATUS.cowork, baseUrl: "" } };
    await mount({ ...props, initialStatus: statusEcho });
    await act(async () => findButton("Apply").click());
    // No server endpoint to seed from: BaseUrlSelect defaults to the loopback preset.
    expect(posts.at(-1).baseUrl).toBe("http://127.0.0.1:20128/v1");
  });
});
