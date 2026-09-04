// @vitest-environment happy-dom
// Behavioral regression tests for media-providers combo/[id] page
// (round-2 T105-T107, T109): T105 test-run button unsticks on HTTP error,
// T106 optimistic model removal reverts on failed save, T107 round-robin
// toggle reverts on failed PATCH, T109 usage logs matched by model column.
// React.createElement (no JSX loader in tests/).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }) => h("a", { href: typeof href === "string" ? href : href?.pathname }, children),
}));

let pushMock = null;
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "combo-1" }),
  useRouter: () => ({ push: pushMock, replace: () => {}, refresh: () => {} }),
  notFound: () => h("div", { "data-testid": "not-found" }),
  usePathname: () => "/dashboard/media-providers/combo/combo-1",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/shared/components", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    ModelSelectModal: () => h("div", { "data-testid": "model-picker" }),
  };
});

import ComboPage from "@/app/(dashboard)/dashboard/media-providers/combo/[id]/page";
import { useNotificationStore } from "@/store/notificationStore";

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: () => Promise.resolve(data),
  headers: { get: () => "application/json" },
});

const COMBO = { id: "combo-1", name: "img", kind: "image", models: ["openai/gpt-image-1", "antigravity/gemini-3.1-flash-image"] };

const LOGS = [
  "2026-09-03T10:00:00Z | gpt-image-1 | openai | acc-1 | 1 | 1 | 200 OK",
  "2026-09-03T10:01:00Z | someimg-model | x | acc-1 | 1 | 1 | 200 OK",
  "2026-09-03T10:02:00Z | gemini-3.1-flash-image | antigravity | acc-1 | 1 | 1 | 200 OK",
];

let root = null;
let container = null;
let fetchMock = null;
let saveFails = false;
let runFails = false;
let strategies = {};
function route(url, init) {
  const method = init?.method;
  if (url === "/api/combos/combo-1" && (!method || method === "GET" || method === "PUT")) {
    if (method === "PUT") return saveFails
      ? jsonResponse({ error: "save rejected" }, { ok: false, status: 500 })
      : jsonResponse({ combo: COMBO });
    return jsonResponse(COMBO);
  }
  if (url === "/api/settings" && init?.method === "PATCH") {
    return runFails
      ? jsonResponse({ error: "patch rejected" }, { ok: false, status: 500 })
      : jsonResponse({});
  }
  if (url === "/api/settings") return jsonResponse({ comboStrategies: strategies });
  if (url === "/api/usage/logs") return jsonResponse(LOGS);
  if (url === "/api/providers") return jsonResponse({ connections: [] });
  if (url === "/api/models/alias") return jsonResponse({ aliases: {} });
  if (String(url).startsWith("/api/v1/")) {
    return runFails
      ? jsonResponse({ error: { message: "boom" } }, { ok: false, status: 500 })
      : jsonResponse({ data: [{ b64_json: "AAAA" }] });
  }
  return jsonResponse({});
}

function mount(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(element));
}

async function flush() {
  await act(async () => {});
}

function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(text) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent.includes(text));
}

beforeEach(() => {
  pushMock = vi.fn();
  saveFails = false;
  strategies = {};
  runFails = false;
  fetchMock = vi.fn((url, init) => Promise.resolve(route(url, init)));
  vi.stubGlobal("fetch", fetchMock);
});

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

describe("media-providers combo detail page", () => {
  it("T105: failed example run shows the error and re-enables the Run button", async () => {
    runFails = true;
    mount(h(ComboPage));
    await flush();

    setNativeValue(container.querySelector("#combo-example-key"), "sk-test");
    const run = findButton("Run");
    expect(run).not.toBeNull();
    expect(run.disabled).toBe(false);

    await act(async () => {
      run.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.textContent).toContain("boom");
    const after = findButton("Run");
    expect(after).not.toBeNull();
    expect(after.disabled).toBe(false);
  });

  it("T108: renaming a combo migrates its round-robin strategy to the new name", async () => {
    strategies = { img: { fallbackStrategy: "round-robin" } };
    mount(h(ComboPage));
    await flush();

    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    const nameInput = container.querySelector("input");
    expect(nameInput).not.toBeNull();
    setNativeValue(nameInput, "renamed");
    await act(async () => {
      nameInput.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    await flush();

    const patch = fetchMock.mock.calls.find(([u, i]) => u === "/api/settings" && i?.method === "PATCH");
    expect(patch).toBeDefined();
    const body = JSON.parse(patch[1].body);
    expect(body.comboStrategies.renamed).toEqual({ fallbackStrategy: "round-robin" });
    expect(body.comboStrategies.img).toBeUndefined();
  });
  it("T106: failed model save reverts the optimistic removal", async () => {
    mount(h(ComboPage));
    await flush();

    // gpt-image-1 provider row is rendered before removal
    expect(container.textContent).toContain("gpt-image-1");

    saveFails = true;
    const remove = container.querySelector('button[aria-label^="Remove"]');
    expect(remove).not.toBeNull();
    await act(async () => {
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    // PUT failed -> row must come back
    expect(container.textContent).toContain("gpt-image-1");
    const notes = useNotificationStore.getState().notifications;
    expect(notes.some((n) => String(n.message).includes("save rejected"))).toBe(true);
  });

  it("T107: failed round-robin PATCH reverts the toggle", async () => {
    mount(h(ComboPage));
    await flush();

    const toggle = container.querySelector('button[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    runFails = true; // /api/settings PATCH -> 500
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    const after = container.querySelector('button[role="switch"]');
    expect(after.getAttribute("aria-checked")).toBe("false");
  });

  it("T109: usage logs are matched by model column, not substring of combo name", async () => {
    mount(h(ComboPage));
    await flush();

    const text = container.textContent;
    expect(text).toContain("gpt-image-1");
    expect(text).toContain("gemini-3.1-flash-image");
    // "someimg-model" merely contains the combo name "img" — must not be shown
    expect(text).not.toContain("someimg-model");
  });
});
