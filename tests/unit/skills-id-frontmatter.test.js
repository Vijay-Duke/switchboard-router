// @vitest-environment happy-dom
// @ts-check
// T115: navigating skill A → B must clear A's frontmatter so A's title never
// renders under B while B's fetch is pending (and not at all on error).
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHarness, jsonResponse, h } from "./dashboard-dom-harness.js";

const route = vi.hoisted(() => ({ id: "skill-a", bGate: null }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: route.id }),
}));
vi.mock("next/link", () => ({
  default: ({ children }) => React.createElement(React.Fragment, null, children),
}));

import SkillDetailPage from "../../src/app/(dashboard)/dashboard/skills/[id]/page.js";

const md = (name, description = "d") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`;

describe("skills/[id] page (T115)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route.id = "skill-a";
    route.bGate = null;
  });

  it("does not leak skill A's title while skill B is loading", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u === "/api/skills/skill-a") return new Response(md("Skill A"), { status: 200 });
      if (u === "/api/skills/skill-b") {
        // B never resolves during the assertion window.
        return new Promise(() => {});
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const harness = createHarness();
    await harness.mount(h(SkillDetailPage));
    await new Promise((r) => setTimeout(r, 10));
    expect(harness.container.textContent).toContain("Skill A");

    route.id = "skill-b";
    await harness.rerender(h(SkillDetailPage));
    await new Promise((r) => setTimeout(r, 10));

    expect(harness.container.textContent).not.toContain("Skill A");
    // Falls back to the raw id while B is pending — not to A's frontmatter.
    expect(harness.container.textContent).toContain("skill-b");
    harness.unmount();
  });

  it("does not leak skill A's title when B's fetch fails", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u === "/api/skills/skill-a") return new Response(md("Skill A"), { status: 200 });
      return jsonResponse({ error: "not found" }, 404);
    });

    const harness = createHarness();
    await harness.mount(h(SkillDetailPage));
    await new Promise((r) => setTimeout(r, 10));

    route.id = "skill-b";
    await harness.rerender(h(SkillDetailPage));
    await new Promise((r) => setTimeout(r, 10));

    expect(harness.container.textContent).not.toContain("Skill A");
    harness.unmount();
  });
});
