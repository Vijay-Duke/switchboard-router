// Shared react-dom/client + act helpers for dashboard component tests
// (pattern from overview-load-error.test.js / providers-toggle.test.js).
// Test files using this must declare `// @vitest-environment happy-dom`.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const h = React.createElement;
/** Cards mount ModelSelectModal, whose hooks need a QueryClient even closed. */
export function withQueryClient(element) {
  return h(QueryClientProvider, { client: new QueryClient() }, element);
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom under vitest does not expose window.localStorage; components
// persist UI prefs there, so give them a minimal in-memory Storage.
if (typeof globalThis.localStorage === "undefined") {
  const backing = new Map();
  const storage = {
    getItem: (k) => (backing.has(String(k)) ? backing.get(String(k)) : null),
    setItem: (k, v) => void backing.set(String(k), String(v)),
    removeItem: (k) => void backing.delete(String(k)),
    clear: () => backing.clear(),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }
}

export function createHarness() {
  let root = null;
  let container = null;
  return {
    get container() {
      return container;
    },
    async mount(element) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(element);
      });
      return container;
    },
    async rerender(element) {
      await act(async () => {
        root.render(element);
      });
    },
    unmount() {
      if (root) {
        act(() => root.unmount());
        root = null;
      }
      container?.remove();
      container = null;
    },
  };
}

/** Flush microtasks/macrotasks inside act so pending fetch chains settle. */
export async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export async function settle(predicate, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    let done = false;
    try {
      done = !!predicate();
    } catch {
      done = false;
    }
    if (done) return;
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Set a controlled input/select/textarea value through the native setter so React sees the change. */
export async function setValue(el, value) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export async function fire(el, type, init = {}) {
  const Ctor = type.startsWith("key") ? KeyboardEvent : type.startsWith("focus") ? FocusEvent : Event;
  await act(async () => {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  });
}

export function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

/** A fetch response whose resolution the test controls. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function findByText(container, selector, text) {
  return [...container.querySelectorAll(selector)].find((el) => el.textContent.trim() === text) || null;
}

/** Match by trailing text so icon-prefixed Buttons ("deleteClear") still resolve. */
export function findByLabel(container, selector, text) {
  return [...container.querySelectorAll(selector)].find((el) => el.textContent.trim().endsWith(text)) || null;
}
