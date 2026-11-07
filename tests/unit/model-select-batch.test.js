// @vitest-environment happy-dom
// Batch select/deselect over the filtered model list only renders when the
// parent passes batch handlers, and hands the visible models over in one call.
import { afterEach, describe, expect, it, vi } from "vitest";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { createHarness, h, click, jsonResponse, settle, setValue, withQueryClient } from "./dashboard-dom-harness.js";

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

const stubFetch = () => vi.stubGlobal("fetch", vi.fn(async (url) => {
  const u = String(url);
  if (u.startsWith("/api/models/routable")) {
    return jsonResponse({ data: [{ id: "gem/alpha" }, { id: "gem/beta" }, { id: "gem/gamma-embed" }] });
  }
  if (u === "/api/combos") return jsonResponse({ combos: [] });
  if (u === "/api/provider-nodes") return jsonResponse({ nodes: [] });
  if (u === "/api/models/custom") return jsonResponse({ models: [] });
  if (u === "/api/models/disabled") return jsonResponse({ disabled: {} });
  return jsonResponse({});
}));

const mount = (props) => {
  harness = createHarness();
  return harness.mount(withQueryClient(h(ModelSelectModal, {
    isOpen: true,
    onClose: () => {},
    onSelect: () => {},
    activeProviders: [{ provider: "gemini", isActive: true }],
    closeOnSelect: false,
    ...props,
  })));
};

describe("ModelSelectModal batch actions", () => {
  it("hides Select all when no batch handler is provided", async () => {
    stubFetch();
    const container = await mount({});
    await settle(() => /model/i.test(document.body.textContent), "modal rendered");
    expect(document.body.textContent).not.toMatch(/Select all \(/);
    expect(container).toBeTruthy();
  });

  it("passes exactly the filtered, unadded models to onSelectBatch / onDeselectBatch", async () => {
    stubFetch();
    const onSelectBatch = vi.fn();
    const onDeselectBatch = vi.fn();
    await mount({ onSelectBatch, onDeselectBatch, addedModelValues: ["mmf/mimo-auto"] });
    const search = document.body.querySelector('input[aria-label="Search models"]');
    // Narrow to the one no-auth model that is already added: only Deselect applies.
    await setValue(search, "mimo-auto");
    await settle(() => /Deselect all \(1\)/.test(document.body.textContent), "deselect button");
    expect([...document.body.querySelectorAll("button")].some((b) => /^Select all \(/.test(b.textContent.trim()))).toBe(false);
    const deselect = [...document.body.querySelectorAll("button")].find((b) => /^Deselect all \(/.test(b.textContent.trim()));
    await click(deselect);
    expect(onDeselectBatch.mock.calls[0][0].map((m) => m.value)).toEqual(["mmf/mimo-auto"]);

    // An exclusion that removes it leaves nothing to batch over.
    await setValue(search, "mimo-auto !mimo");
    await settle(() => !/Deselect all \(/.test(document.body.textContent), "batch hidden");
    expect(onSelectBatch).not.toHaveBeenCalled();
  });
});
