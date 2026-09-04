import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source-level regression tests for the W1-ticket UI fixes that need no DOM:
// Tooltip focus semantics, modal search markup, settings theme removal,
// single version fetch, and console onopen wiring.

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const tooltip = read("src/shared/components/Tooltip.js");
const modal = read("src/shared/components/ModelSelectModal.js");
const profile = read(
  "src/app/(dashboard)/dashboard/profile/ProfilePageClient.js",
);
const sidebar = read("src/shared/components/Sidebar.js");
const consoleClient = read(
  "src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js",
);
const streamRoute = read(
  "src/app/api/translator/console-logs/stream/route.js",
);

describe("Tooltip keyboard-only focus (W1c)", () => {
  it("uses focus-visible semantics so programmatic focus stays quiet", () => {
    expect(tooltip).toContain("group-has-focus-visible/tt:opacity-100");
    expect(tooltip).not.toContain(" group-focus-visible/tt");
    expect(tooltip).not.toContain("group-focus-within");
  });

  it("keeps hover display and the aria-describedby merge", () => {
    expect(tooltip).toContain("group-hover/tt:opacity-100");
    expect(tooltip).toContain("aria-describedby");
  });
});

describe("ModelSelectModal search UX (W1)", () => {
  it("autofocuses the search input on open", () => {
    expect(modal).toContain("searchInputRef");
    expect(modal).toContain("autoFocus");
  });

  it("shows N of M in the group header while a query is active", () => {
    expect(modal).toContain("hasSearchQuery");
    expect(modal).toContain("totalModels");
    expect(modal).toContain("of ${group.totalModels");
  });

  it("explains empty results with the active query", () => {
    expect(modal).toContain("No models match");
  });

  it("keeps the list area fixed-height so the modal does not jump", () => {
    expect(modal).toContain("h-[50vh]");
  });

  it("delegates query matching to the shared testable helper", () => {
    expect(modal).toContain("filterModelGroupsByQuery");
  });
});

describe("Settings theme selector removal (W11)", () => {
  it("has no Light/Dark/System selector or theme hook usage", () => {
    expect(profile).not.toContain("useTheme");
    expect(profile).not.toContain("setTheme");
    expect(profile).not.toContain('"light", "dark", "system"');
    expect(profile).not.toContain("['light', 'dark', 'system']");
  });
});

describe("single /api/version fetch (W9 client)", () => {
  it("shares one module-level version request across mounts", () => {
    expect(sidebar).toContain("fetchVersionOnce");
    expect(sidebar).toContain("let versionRequest = null");
  });
});

describe("console connecting state (W13)", () => {
  it("sets connected in EventSource onopen", () => {
    expect(consoleClient).toContain("es.onopen");
    expect(consoleClient).toContain("setConnected(true)");
  });

  it("emits an initial comment frame so onopen fires before any log", () => {
    expect(streamRoute).toContain('": connected\\n\\n"');
  });
});
