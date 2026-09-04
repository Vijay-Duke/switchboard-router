// @vitest-environment happy-dom
// T36/T37/T38: ClaudeToolCard hybrid endpoint seeding, full-catalog profile
// load failures, and the cc filter-naming toggle's server-truth behavior.

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, click, jsonResponse, settle, withQueryClient } from "./dashboard-dom-harness.js";
import ClaudeToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const h = React.createElement;

vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

/**
 * @param {object} opts
 * @param {object} [opts.status] claude-settings payload
 * @param {object|Response} [opts.fullCatalog] claude-full-catalog payload or Response
 * @param {Response} [opts.settingsResponse] /api/settings Response
 * @param {Response} [opts.patchResponse] PATCH /api/settings Response
 */
function stubClaudeRoutes({ status, fullCatalog, settingsResponse, patchResponse } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const urlStr = String(url);
    if (urlStr === "/api/cli-tools/claude-settings") return jsonResponse(status ?? {});
    if (urlStr === "/api/cli-tools/claude-full-catalog") {
      return fullCatalog && typeof fullCatalog.json === "function"
        ? fullCatalog
        : jsonResponse(fullCatalog ?? { configured: false, models: [] });
    }
    if (urlStr === "/api/settings" && init?.method === "PATCH") {
      return patchResponse ?? jsonResponse({ ok: true });
    }
    if (urlStr === "/api/settings") {
      return settingsResponse ?? jsonResponse({ ccFilterNaming: false });
    }
    if (urlStr === "/api/models/alias") return jsonResponse({ aliases: {} });
    return jsonResponse({});
  }));
}

function claudeCard() {
  return h(ClaudeToolCard, {
    tool: CLI_TOOLS.claude,
    isExpanded: true,
    onToggle: () => {},
    baseUrl: "http://127.0.0.1:20128",
    apiKeys: [{ keySecret: "sk_test", keyPrefix: "sk_t…" }],
    activeProviders: [],
    hasActiveProviders: true,
    modelMappings: {},
    onModelMappingChange: () => {},
    cloudEnabled: false,
  });
}

describe("ClaudeToolCard (T36/T37/T38)", () => {
  it("seeds the hybrid endpoint dropdown from the server base URL (T36)", async () => {
    stubClaudeRoutes({
      status: { installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: { ANTHROPIC_BASE_URL: "https://tunnel.example.com/v1" } } },
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(claudeCard()));
    await settle(() => container.querySelector('input[placeholder="https://example.com/v1"]') !== null, "endpoint UI");
    const customInput = container.querySelector('input[placeholder="https://example.com/v1"]');
    expect(customInput.value).toBe("https://tunnel.example.com/v1");
    const select = container.querySelector("select");
    expect(select.value).not.toBe("local");
  });

  it("shows the full-catalog profile error with Retry when the profile read fails (T37)", async () => {
    stubClaudeRoutes({
      status: { installed: true, hasSwitchboard: true, routingMode: "proxy", settings: { env: {} } },
      fullCatalog: jsonResponse({ error: "corrupt profile" }, 500),
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(claudeCard()));
    await settle(() => container.querySelector('[role="alert"]') !== null, "profile error alert");
    expect(container.querySelector('[role="alert"]').textContent).toContain("corrupt profile");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry");
    expect(retry).toBeTruthy();
    await click(retry);
    await settle(() => container.querySelector('[role="alert"]') !== null, "still failing after retry");
  });

  it("reverts the filter-naming toggle when PATCH fails (T38)", async () => {
    stubClaudeRoutes({
      status: { installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: {} } },
      settingsResponse: jsonResponse({ ccFilterNaming: true }),
      patchResponse: jsonResponse({ error: "nope" }, 500),
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(claudeCard()));
    await settle(() => {
      const box = container.querySelector("input[type=checkbox]");
      return box && box.checked;
    }, "checkbox seeded true from server");
    const box = container.querySelector("input[type=checkbox]");
    await click(box); // uncheck -> PATCH 500 -> revert to checked
    await settle(() => box.checked === true, "toggle reverted after failed PATCH");
  });

  it("keeps the toggle off when the initial settings read fails (T38)", async () => {
    stubClaudeRoutes({
      status: { installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: {} } },
      settingsResponse: jsonResponse({ error: "down" }, 500),
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(claudeCard()));
    await settle(() => container.querySelector("input[type=checkbox]") !== null, "checkbox rendered");
    expect(container.querySelector("input[type=checkbox]").checked).toBe(false);
  });
});

describe("ClaudeToolCard env-file key match (T62)", () => {
  it("selects the settings.json token even when /api/keys resolves after status", async () => {
    stubClaudeRoutes({
      status: { installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: { ANTHROPIC_AUTH_TOKEN: "sk_late" } } },
    });
    harness = createHarness();
    const card = (apiKeys) => withQueryClient(h(ClaudeToolCard, {
      tool: CLI_TOOLS.claude,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: "http://127.0.0.1:20128",
      apiKeys,
      activeProviders: [],
      hasActiveProviders: true,
      modelMappings: {},
      onModelMappingChange: () => {},
      cloudEnabled: false,
    }));
    const container = await harness.mount(card([]));
    await settle(() => container.querySelector("input[type=password]") !== null, "key field rendered (status resolved first)");
    expect(container.querySelector("input[type=password]").value).toBe("");

    await harness.rerender(card([{ keySecret: "sk_late", keyPrefix: "sk_l…" }]));
    await settle(() => container.querySelector("input[type=password]").value === "sk_late", "late key matched");
  });
});
