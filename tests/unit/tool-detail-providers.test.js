// @vitest-environment happy-dom
// T17/T18/T19: ToolDetailClient provider gating + load-error surface + tunnel props.
// T17: a live openai-compatible connection with no static catalog models must
//      still unlock model pickers (compatible providers serve arbitrary models).
// T18: /api/providers failure renders an alert instead of an empty dashboard.
// T19: cline's Connected badge honors the tunnel URL from /api/settings.

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { click, createHarness, jsonResponse, settle, withQueryClient } from "./dashboard-dom-harness.js";
import { findByLabel, findByText } from "./dashboard-dom-harness.js";
import ToolDetailClient from "../../src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js";

const h = React.createElement;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }) => h("a", { href, ...rest }, children),
}));
vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

/**
 * @param {object} opts
 * @param {Array} [opts.connections] /api/providers payload
 * @param {object} [opts.providersResponse] full Response override for /api/providers
 * @param {object} [opts.settings] /api/settings payload
 */
function stubDetailRoutes({ connections, providersResponse, settings } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr === "/api/providers") {
      return providersResponse ?? jsonResponse({ connections: connections ?? [] });
    }
    if (urlStr === "/api/keys") return jsonResponse({ keys: [] });
    if (urlStr === "/api/settings") return jsonResponse(settings ?? {});
    if (urlStr === "/api/cli-tools/claude-settings") {
      return jsonResponse({ installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: {} } });
    }
    if (urlStr === "/api/cli-tools/claude-full-catalog") {
      return jsonResponse({ configured: false, models: [] });
    }
    if (urlStr === "/api/cli-tools/cline-settings") {
      return jsonResponse({
        installed: true,
        hasSwitchboard: true,
        settings: { baseUrl: settings?.tunnelPublicUrl ? `${settings.tunnelPublicUrl}/v1` : "https://elsewhere.example.com/v1", models: ["p/a"], defaultModel: "p/a" },
      });
    }
    if (urlStr === "/api/models/alias") return jsonResponse({ aliases: {} });
    return jsonResponse({});
  }));
}

const mountDetail = (toolId) => harness.mount(withQueryClient(h(ToolDetailClient, { toolId })));

describe("ToolDetailClient (T17/T18/T19)", () => {
  it("unlocks Select Model for a compatible-only provider with no catalog models (T17)", async () => {
    stubDetailRoutes({ connections: [{ name: "c1", provider: "openai-compatible-foo", isActive: true }] });
    harness = createHarness();
    const container = await mountDetail("claude");
    await settle(() => findByText(container, "button", "Select Model") !== null, "Select Model rendered");
    expect(findByText(container, "button", "Select Model").disabled).toBe(false);
  });

  it("keeps Select Model locked when the only connection is inactive (T17 control)", async () => {
    stubDetailRoutes({ connections: [{ name: "c1", provider: "openai", isActive: false }] });
    harness = createHarness();
    const container = await mountDetail("claude");
    await settle(() => findByText(container, "button", "Select Model") !== null, "Select Model rendered");
    expect(findByText(container, "button", "Select Model").disabled).toBe(true);
  });

  it("renders an alert when /api/providers fails (T18)", async () => {
    stubDetailRoutes({ providersResponse: jsonResponse({ error: "boom" }, 500) });
    harness = createHarness();
    const container = await mountDetail("claude");
    await settle(() => container.querySelector('[role="alert"]') !== null, "load-error alert");
    expect(container.querySelector('[role="alert"]').textContent).toContain("boom");
  });

  it("badges cline Connected when its base URL matches the configured tunnel (T19)", async () => {
    stubDetailRoutes({ settings: { tunnelPublicUrl: "https://t.example.com" } });
    harness = createHarness();
    const container = await mountDetail("cline");
    await settle(() => findByText(container, "span", "Connected") !== null, "badge Connected");
  });

  it("badges cline Other when the base URL matches no known endpoint (T19 control)", async () => {
    stubDetailRoutes({ settings: {} });
    harness = createHarness();
    const container = await mountDetail("cline");
    await settle(() => findByText(container, "span", "Other") !== null, "badge Other");
  });
});

describe("ToolDetailClient Retry (T18)", () => {
  it("reloads and clears the alert when Retry succeeds", async () => {
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr === "/api/providers") {
        return failing ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ connections: [] });
      }
      if (urlStr === "/api/keys") return jsonResponse({ keys: [] });
      if (urlStr === "/api/settings") return jsonResponse({});
      if (urlStr === "/api/cli-tools/claude-settings") {
        return jsonResponse({ installed: true, hasSwitchboard: true, routingMode: "pass-through", settings: { env: {} } });
      }
      return jsonResponse({});
    }));
    harness = createHarness();
    const container = await mountDetail("claude");
    await settle(() => container.querySelector('[role="alert"]') !== null, "load-error alert");
    failing = false;
    await click(findByLabel(container, "button", "Retry"));
    await settle(() => container.querySelector('[role="alert"]') === null, "alert cleared after retry");
  });
});
