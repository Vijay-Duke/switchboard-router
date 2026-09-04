// @vitest-environment happy-dom
// O5: step-1 meta detection is debounced and drops stale responses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createHarness, h, setValue, jsonResponse, deferred } from "./dashboard-dom-harness.js";

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor({ value, onChange }) {
      return h("textarea", { "data-testid": "editor", value: value || "", onChange: (e) => onChange(e.target.value) });
    },
}));

const { default: TranslatorPage } = await import("@/app/(dashboard)/dashboard/translator/page.js");

const harness = createHarness();

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  harness.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const detectCalls = (fetchMock) =>
  fetchMock.mock.calls.filter(([u, o]) => String(u) === "/api/translator/translate" && o?.body?.includes('"step":1'));

describe("translator detectMeta (O5)", () => {
  it("issues one detect request for a burst of keystrokes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ success: true, result: { provider: "p", model: "m" } })));
    vi.stubGlobal("fetch", fetchMock);
    const container = await harness.mount(h(TranslatorPage));
    const editor = container.querySelector('[data-testid="editor"]');

    for (const text of ['{"m', '{"mo', '{"mod', '{"mode', '{"model":"x"}']) {
      await setValue(editor, text);
    }
    expect(detectCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(detectCalls(fetchMock)).toHaveLength(1);
  });

  it("drops a slow earlier detect that resolves after a newer one", async () => {
    const slow = deferred();
    const fetchMock = vi.fn((url, options) => {
      if (options?.body?.includes('"first"')) return slow.promise;
      return Promise.resolve(jsonResponse({ success: true, result: { provider: "newer-provider", model: "m2" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = await harness.mount(h(TranslatorPage));
    const editor = container.querySelector('[data-testid="editor"]');

    await setValue(editor, '{"model":"first"}');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await setValue(editor, '{"model":"second"}');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(detectCalls(fetchMock)).toHaveLength(2);
    expect(container.textContent).toContain("newer-provider");

    await act(async () => {
      slow.resolve(jsonResponse({ success: true, result: { provider: "stale-provider", model: "m1" } }));
    });
    expect(container.textContent).toContain("newer-provider");
    expect(container.textContent).not.toContain("stale-provider");
  });
});
