// @vitest-environment happy-dom
// Gate follow-ups for the cli-tools cards:
// T35 — card headers are keyboard-reachable (Enter/Space toggle, nested keys ignored)
// T31 — model removal never calls setState inside another updater
// T22 — the dead AntigravityToolCard is gone; every custom-config tool has a renderer case
// T32 — the endpoint dropdown is seeded from the server URL on every settings card
// T67 — the MITM password field kept its styling when it became type="password"

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, fire, jsonResponse, settle, withQueryClient } from "./dashboard-dom-harness.js";
import DefaultToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js";
import KiloToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/KiloToolCard.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const h = React.createElement;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const compPath = (name) => path.resolve(HERE, "../../src/app/(dashboard)/dashboard/cli-tools/components", `${name}.js`);
const comp = (name) => readFileSync(compPath(name), "utf8");

vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

const HEADER_CARDS = [
  "DefaultToolCard", "KiloToolCard", "HermesToolCard", "JcodeToolCard", "DeepSeekTuiToolCard",
  "DroidToolCard", "OpenClawToolCard", "OpenCodeToolCard", "OpenAiCompatToolCard", "CoworkToolCard",
  "ClineToolCard", "CodexToolCard", "MitmToolCard",
];

describe("card header keyboard toggle (T35)", () => {
  it("toggles on Enter/Space from the header itself, not from nested elements", async () => {
    const onToggle = vi.fn();
    harness = createHarness();
    const container = await harness.mount(withQueryClient(h(DefaultToolCard, {
      toolId: "cursor",
      tool: { name: "Cursor", description: "editor", guideSteps: [] },
      isExpanded: false,
      onToggle,
      baseUrl: "http://127.0.0.1:20128",
      apiKeys: [],
    })));
    const header = container.querySelector('[role="button"][aria-expanded]');
    expect(header.getAttribute("tabindex")).toBe("0");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await fire(header, "keydown", { key: "Enter" });
    await fire(header, "keydown", { key: " " });
    await fire(header, "keydown", { key: "a" });
    expect(onToggle).toHaveBeenCalledTimes(2);
    // A key pressed on a child (bubbling up) must not double-toggle.
    await fire(header.querySelector("h3"), "keydown", { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("every collapsible card header exposes role=button + aria-expanded", () => {
    for (const name of HEADER_CARDS) {
      const src = comp(name);
      expect(src, name).toMatch(/cardHeaderToggleProps\(onToggle, isExpanded, tool\.name\)|role="button"/);
      expect(src, name).not.toMatch(/<div className="[^"]*" onClick=\{onToggle\}>/);
    }
  });
});

describe("removeModel updaters stay pure (T31)", () => {
  it.each(["ClineToolCard", "KiloToolCard", "HermesToolCard", "JcodeToolCard", "OpenClawToolCard"])("%s", (name) => {
    // setSelectedModel/setActModel/... must be issued outside setSelectedModels' updater.
    expect(comp(name)).not.toMatch(/setSelectedModels\(\(current\) => \{[^}]*set(Selected|Act|Plan)Model\(/);
  });
});

describe("dead AntigravityToolCard removed, custom tools have renderers (T22)", () => {
  it("file and index export are gone", () => {
    expect(existsSync(compPath("AntigravityToolCard"))).toBe(false);
    expect(comp("index")).not.toContain("AntigravityToolCard");
  });

  it("every configType: custom tool has an explicit case in ToolDetailClient", () => {
    const detail = readFileSync(path.resolve(HERE, "../../src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js"), "utf8");
    const customIds = Object.entries(CLI_TOOLS).filter(([, t]) => t.configType === "custom").map(([id]) => id);
    expect(customIds.length).toBeGreaterThan(0);
    for (const id of customIds) expect(detail, id).toContain(`case "${id}":`);
  });
});

describe("endpoint dropdown seeded from the server (T32)", () => {
  it.each([
    "KiloToolCard", "HermesToolCard", "JcodeToolCard", "DeepSeekTuiToolCard", "DroidToolCard",
    "OpenClawToolCard", "OpenCodeToolCard", "OpenAiCompatToolCard", "CoworkToolCard", "ClineToolCard", "CodexToolCard",
  ])("%s passes initialUrl to BaseUrlSelect", (name) => {
    expect(comp(name)).toMatch(/<BaseUrlSelect[\s\S]*?initialUrl=\{/);
  });

  it("Kilo shows the server's tunnel URL instead of repointing to loopback", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url) === "/api/cli-tools/kilo-settings") {
        return jsonResponse({ installed: true, hasSwitchboard: true, settings: { baseUrl: "https://tunnel.example.com/v1", models: ["p/a"], defaultModel: "p/a" } });
      }
      if (String(url) === "/api/models/alias") return jsonResponse({ aliases: {} });
      return jsonResponse({});
    }));
    harness = createHarness();
    const container = await harness.mount(withQueryClient(h(KiloToolCard, {
      tool: CLI_TOOLS.kilo,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: "http://127.0.0.1:20128",
      apiKeys: [],
      activeProviders: [],
      cloudEnabled: false,
    })));
    await settle(() => container.querySelector("select") !== null, "endpoint select rendered");
    expect(container.querySelector("select").value).not.toBe("local");
    expect(container.querySelector("input[placeholder='https://example.com/v1']").value).toBe("https://tunnel.example.com/v1");
  });
});

describe("MITM key field styling survived the password change (T67)", () => {
  it("keeps a className on the password input", () => {
    expect(comp("MitmServerCard")).toMatch(/id="mitm-api-key"[\s\S]*?type="password"[\s\S]*?className="[^"]*border-border[^"]*"/);
  });
});
