// @vitest-environment happy-dom
// @ts-check
// Agent Library page render tests for round-2 findings:
// T1 catalog preset switch resets the confirm checkbox,
// T4 ensure_product failure surfaces notify.error,
// T6 project path commits once on blur (not per keystroke),
// T7 discovered skills are real <button> elements,
// T8 catalog load failure surfaces notify.error,
// T9 skill delete failure surfaces notify.error.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHarness, setValue, fire, jsonResponse, findByLabel } from "./dashboard-dom-harness.js";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => notify,
}));
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/store/confirmationStore", () => ({
  requestConfirmation: confirmMock,
}));

// Server page metadata (+ any next/link usage) stays out of scope.
vi.mock("next/link", () => ({ default: ({ children }) => React.createElement(React.Fragment, null, children) }));

import AgentLibraryPage from "../../src/app/(dashboard)/dashboard/agent-library/page.js";
import { h } from "./dashboard-dom-harness.js";

const libraryPayload = (over = {}) => ({
  settings: { scope: "global", targets: {}, ...over.settings },
  agents: over.agents ?? {},
  skills: over.skills ?? [],
  mcpServers: over.mcpServers ?? [],
});

/** Route global fetch by regex; unmatched URLs 404 loudly. */
function routeFetch(handlers) {
  return vi.fn(async (url, init) => {
    const u = String(url);
    for (const [re, fn] of handlers) {
      if (re.test(u)) return fn(u, init);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

const baseHandlers = (library = libraryPayload()) => [
  [/\/api\/agent-library\/updates/, () => jsonResponse({ results: [] })],
  [/\/api\/agent-library\/catalog$/, (_u, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.action === "preview") return jsonResponse({ ok: true, preview: `# preview ${body.url}`, bytes: 12 });
      if (body.action === "resolve") {
        return jsonResponse({
          ok: true,
          skills: [
            { skillId: "one", title: "Skill One", rawUrl: "https://x/1.md", path: "p/1" },
            { skillId: "two", title: "Skill Two", rawUrl: "https://x/2.md", path: "p/2" },
          ],
        });
      }
    }
    return jsonResponse({ presets: [], mcpPresets: [] });
  }],
  [/\/api\/agent-library$/, (_u, init) => (init?.method === "PATCH" ? jsonResponse({ ok: true }) : jsonResponse(library))],
  [/\/api\/agent-library\/skills/, (_u, init) => {
    if (init?.method === "POST") return jsonResponse({ error: "boom" }, 500);
    if (init?.method === "DELETE") return jsonResponse({ error: "delete boom" }, 500);
    throw new Error("unexpected skills call");
  }],
];

async function mountPage(handlers = baseHandlers()) {
  globalThis.fetch = routeFetch(handlers);
  const harness = createHarness();
  await harness.mount(h(AgentLibraryPage));
  await new Promise((r) => setTimeout(r, 0));
  return harness;
}

const tabButton = (container, label) => findByLabel(container, "button", label);

describe("agent-library page (round-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("T6: project path PATCHes once on blur, not per keystroke", async () => {
    const fetchMock = routeFetch(baseHandlers(libraryPayload({ settings: { scope: "project", projectPath: "" } })));
    globalThis.fetch = fetchMock;
    const harness = createHarness();
    await harness.mount(h(AgentLibraryPage));
    await new Promise((r) => setTimeout(r, 0));

    const input = harness.container.querySelector('input[placeholder="/Users/you/my-app"]');
    expect(input).toBeTruthy();

    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    await setValue(input, "/tmp");
    await setValue(input, "/tm");
    await setValue(input, "/tmp");
    expect(patches()).toHaveLength(0);

    await fire(input, "focusout", { bubbles: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(patches()[0][1].body)).toEqual({ projectPath: "/tmp" });
    harness.unmount();
  });

  it("T8: catalog load failure surfaces notify.error", async () => {
    const handlers = baseHandlers();
  handlers[1] = [/\/api\/agent-library\/catalog$/, () => jsonResponse({}, 500)];
    await mountPage(handlers);
    await new Promise((r) => setTimeout(r, 10));
    expect(notify.error).toHaveBeenCalledWith("Failed to load skill catalog");
  });

  it("T4: ensure_product failure surfaces notify.error, success toast suppressed", async () => {
    const harness = await mountPage();
    await tabButton(harness.container, "Skills").click();
    await new Promise((r) => setTimeout(r, 0));

    await tabButton(harness.container, "Refresh product skills").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(notify.error).toHaveBeenCalledWith("boom");
    expect(notify.success).not.toHaveBeenCalledWith("Product skills ensured");
    harness.unmount();
  });

  it("T9: skill delete failure surfaces notify.error", async () => {
    const harness = await mountPage(baseHandlers(libraryPayload({ skills: [{ id: "s1", title: "S One" }] })));
    await tabButton(harness.container, "Skills").click();
    await new Promise((r) => setTimeout(r, 0));

    await tabButton(harness.container, "Remove").click();
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmMock).toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith("delete boom");
    harness.unmount();
  });

  it("T7: discovered skills render as real <button> elements that select", async () => {
    const harness = await mountPage();
    await tabButton(harness.container, "Catalog").click();
    await new Promise((r) => setTimeout(r, 0));

    const input = harness.container.querySelector('input[placeholder^="e.g. npx skills add"]');
    await setValue(input, "anthropics/skills");
    await tabButton(harness.container, "Resolve & Preview").click();
    await new Promise((r) => setTimeout(r, 10));

    const discovered = [...harness.container.querySelectorAll("button")]
      .filter((b) => b.textContent.includes("Skill One"));
    expect(discovered).toHaveLength(1);
    expect(discovered[0].tagName).toBe("BUTTON");

    discovered[0].click();
    await new Promise((r) => setTimeout(r, 10));
    const urlInput = [...harness.container.querySelectorAll("input")]
      .find((i) => i.value === "https://x/1.md");
    expect(urlInput).toBeTruthy();
    harness.unmount();
  });

  it("T1: switching presets resets the confirm checkbox so Install stays disabled", async () => {
    const handlers = baseHandlers();
    handlers[1] = [/\/api\/agent-library\/catalog$/, (_u, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: true, preview: "# p", bytes: 3 });
      return jsonResponse({
        presets: [
          { id: "a", name: "Preset A", description: "d", skillId: "pa", rawUrl: "https://x/a.md" },
          { id: "b", name: "Preset B", description: "d", skillId: "pb", rawUrl: "https://x/b.md" },
        ],
        mcpPresets: [],
      });
    }];
    const harness = await mountPage(handlers);
    await tabButton(harness.container, "Catalog").click();
    await new Promise((r) => setTimeout(r, 0));

    await findByLabel(harness.container, "button", "Select").click();
    await new Promise((r) => setTimeout(r, 10));

    const confirmBox = harness.container.querySelector('input[aria-label^="I reviewed"]');
    const install = findByLabel(harness.container, "button", "Install into library");
    expect(install).toBeTruthy();
    expect(install.disabled).toBe(true);
    confirmBox.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(install.disabled).toBe(false);

    // Switch to Preset B: confirm resets, Install is disabled again.
    const selectButtons = [...harness.container.querySelectorAll("button")]
      .filter((b) => b.textContent.trim() === "Select");
    await selectButtons[1].click();
    await new Promise((r) => setTimeout(r, 10));
    expect(confirmBox.checked).toBe(false);
    expect(install.disabled).toBe(true);
    harness.unmount();
  });

  it("T2: Clear empties the input without submitting a resolve", async () => {
    const harness = await mountPage();
    await tabButton(harness.container, "Catalog").click();
    await new Promise((r) => setTimeout(r, 0));

    const input = harness.container.querySelector('input[placeholder^="e.g. npx skills add"]');
    await setValue(input, "stale query");
    const clear = tabButton(harness.container, "Clear");
    expect(clear).toBeTruthy();
    await clear.click();
    await new Promise((r) => setTimeout(r, 10));

    const posts = () => globalThis.fetch.mock.calls.filter(
      ([, init]) => init?.method === "POST" && JSON.parse(init.body).action === "resolve"
    );
    expect(posts()).toHaveLength(0);
    expect(input.value).toBe("");
    harness.unmount();
  });

  it("T1: the preview spinner never appears on other rows' Update buttons", async () => {
    let releasePreview;
    const previewGate = new Promise((resolve) => { releasePreview = resolve; });
    const handlers = baseHandlers(libraryPayload({
      skills: [{ id: "s1", title: "S One" }, { id: "s2", title: "S Two" }],
    }));
    handlers[0] = [/\/api\/agent-library\/updates/, (_u, init) => {
      if (init?.method === "POST") return previewGate.then(() => jsonResponse({ ok: true, markdown: "# m", contentHash: "h" }));
      return jsonResponse({ results: [{ id: "s1", status: "update" }, { id: "s2", status: "update" }] });
    }];
    const harness = await mountPage(handlers);
    await tabButton(harness.container, "Skills").click();
    await new Promise((r) => setTimeout(r, 0));

    const updateButtons = [...harness.container.querySelectorAll("button")]
      .filter((b) => b.textContent.trim() === "Update");
    expect(updateButtons).toHaveLength(2);
    await updateButtons[0].click();
    await new Promise((r) => setTimeout(r, 5));

    // While the preview POST is in flight, no row shows the loading spinner.
    const spinners = [...harness.container.querySelectorAll("button span.material-symbols-outlined")]
      .filter((s) => s.textContent.includes("progress_activity"));
    expect(spinners).toHaveLength(0);

    releasePreview();
    await new Promise((r) => setTimeout(r, 10));
    harness.unmount();
  });
});
