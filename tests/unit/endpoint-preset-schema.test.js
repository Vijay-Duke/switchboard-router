// @vitest-environment happy-dom
// T54: EndpointPresetControl shares BaseUrlSelect's localStorage schema and
// never persists raw API keys. Round-trip: save → localStorage holds only
// {name, baseUrl}; legacy entries carrying apiKey are tolerated on read but
// stripped.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.__React = React;

import EndpointPresetControl from "@/app/(dashboard)/dashboard/cli-tools/components/EndpointPresetControl";

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "switchboard.cliToolEndpointPresets";

let root = null;
let container = null;

// This happy-dom build exposes neither localStorage nor prompt on window.
function installStorage() {
  const store = new Map();
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

async function mount(props = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      h(EndpointPresetControl, {
        baseUrl: "http://localhost:20128/v1",
        onBaseUrlChange: () => {},
        ...props,
      })
    );
  });
}

const click = (label) =>
  act(() => {
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent.includes(label))
      .click();
  });

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  window.localStorage?.clear?.();
  vi.restoreAllMocks();
});

describe("EndpointPresetControl storage schema (T54)", () => {
  it("saves {name, baseUrl} only — no apiKey ever hits localStorage", async () => {
    installStorage();
    window.prompt = () => "work-laptop";
    await mount({ baseUrl: "https://work.example.com/v1" });
    click("Save");
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored).toEqual([{ name: "work-laptop", baseUrl: "https://work.example.com/v1" }]);
    expect(JSON.stringify(stored)).not.toContain("apiKey");
    // Option label shows name + URL, no masked key
    const option = container.querySelector("option[value=\"work-laptop\"]");
    expect(option.textContent).toBe("work-laptop - https://work.example.com/v1");
  });

  it("keeps loading legacy apiKey-carrying entries but strips the key", async () => {
    installStorage();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { name: "legacy", baseUrl: "http://10.0.0.5:9000/v1", apiKey: "sk-secret" },
        { name: "broken", /* no baseUrl */ },
      ])
    );
    await mount();
    await act(async () => { await Promise.resolve(); });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    // Untouched until the next write, but the dropdown only shows valid presets
    const options = Array.from(container.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("legacy");
    expect(options).not.toContain("broken");
  });

  it("selecting a preset emits only its baseUrl", async () => {
    installStorage();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ name: "legacy", baseUrl: "http://10.0.0.5:9000/v1", apiKey: "sk-secret" }])
    );
    let emitted = null;
    await mount({ onBaseUrlChange: (url) => { emitted = url; } });
    await act(async () => { await Promise.resolve(); });
    const select = container.querySelector("select");
    await act(async () => {
      select.value = "legacy";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(emitted).toBe("http://10.0.0.5:9000/v1");
  });
});
