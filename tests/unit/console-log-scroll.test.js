// @vitest-environment happy-dom
// O4: auto-scroll only sticks when the user is already at the bottom;
// O28: a failed Clear DELETE toasts and keeps the logs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConsoleLogClient from "@/app/(dashboard)/dashboard/console-log/ConsoleLogClient";
import { useNotificationStore } from "@/store/notificationStore";
import { createHarness, h, settle, click, fire, jsonResponse, findByLabel } from "./dashboard-dom-harness.js";
import { act } from "react";

const harness = createHarness();
let sources = [];

class FakeEventSource {
  constructor(url) {
    this.url = url;
    sources.push(this);
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  close() {}
}

beforeEach(() => {
  sources = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  harness.unmount();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
});

function setScrollMetrics(el, { scrollHeight, clientHeight }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
}

async function mountWithLogs() {
  const container = await harness.mount(h(ConsoleLogClient));
  const es = sources[0];
  await act(async () => es.emit({ type: "init", logs: ["[INFO] one", "[INFO] two"] }));
  const log = container.querySelector('[aria-label="Console log stream"]');
  setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 100 });
  return { container, es, log };
}

describe("console auto-scroll (O4)", () => {
  it("does not move the view when the user scrolled up", async () => {
    const { es, log } = await mountWithLogs();
    log.scrollTop = 100;
    await fire(log, "scroll");

    await act(async () => es.emit({ type: "line", line: "[INFO] three" }));
    expect(log.scrollTop).toBe(100);
  });

  it("pins to the bottom when the user is near the bottom", async () => {
    const { es, log } = await mountWithLogs();
    log.scrollTop = 900;
    await fire(log, "scroll");

    await act(async () => es.emit({ type: "line", line: "[INFO] three" }));
    expect(log.scrollTop).toBe(1000);
  });
});

describe("console clear (O28)", () => {
  it("toasts and keeps the logs when DELETE fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({}, 500))));
    const { container } = await mountWithLogs();

    await click(findByLabel(container, "button", "Clear"));
    await settle(
      () => useNotificationStore.getState().notifications.some((n) => n.message.includes("Failed to clear console logs")),
      "clear error toast",
    );
    expect(container.textContent).toContain("[INFO] one");
  });
});
