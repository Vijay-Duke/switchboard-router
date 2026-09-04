// @vitest-environment happy-dom
// T28/T29/T30/T32 for ClineToolCard and CodexToolCard:
// - settings-route failures render status.error instead of pretending "not installed"
// - /api/models/alias fetched exactly once per expand
// - background status refreshes never wipe in-progress edits
// - endpoint dropdown seeded from the server-configured base URL

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, click, jsonResponse, settle, setValue, withQueryClient } from "./dashboard-dom-harness.js";
import { findByLabel } from "./dashboard-dom-harness.js";
import ClineToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js";
import CodexToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const h = React.createElement;

vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

/** Routes: { cline: body|response, codex: body|response, aliasCalls } */
function stubRoutes({ cline, codex, postCline, postCodex } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const urlStr = String(url);
    calls.push(urlStr);
    const respond = (route) => (
      route && typeof route.json === "function" ? route : jsonResponse(route ?? {})
    );
    if (urlStr === "/api/cli-tools/cline-settings" && init?.method === "POST") return respond(postCline ?? { ok: true });
    if (urlStr === "/api/cli-tools/cline-settings") return respond(cline ?? {});
    if (urlStr === "/api/cli-tools/codex-settings" && init?.method === "POST") return respond(postCodex ?? { ok: true });
    if (urlStr === "/api/cli-tools/codex-settings") return respond(codex ?? {});
    if (urlStr === "/api/models/alias") return jsonResponse({ aliases: {} });
    return jsonResponse({});
  }));
  return calls;
}

const apiKeys = [{ keySecret: "sk_test", keyPrefix: "sk_t…" }];
const aliasCalls = (calls) => calls.filter((u) => u === "/api/models/alias").length;

const clineCard = () => h(ClineToolCard, {
  tool: CLI_TOOLS.cline,
  isExpanded: true,
  onToggle: () => {},
  baseUrl: "http://127.0.0.1:20128",
  apiKeys,
  activeProviders: [],
  cloudEnabled: false,
});
const codexCard = () => h(CodexToolCard, {
  tool: CLI_TOOLS.codex,
  isExpanded: true,
  onToggle: () => {},
  baseUrl: "http://127.0.0.1:20128",
  apiKeys,
  activeProviders: [],
  cloudEnabled: false,
});

describe("ClineToolCard (T28/T29/T30/T32)", () => {
  it("renders the route error when cline-settings 500s (T28)", async () => {
    stubRoutes({ cline: jsonResponse({ error: "boom" }, 500) });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(clineCard()));
    await settle(() => container.querySelector('[role="alert"]') !== null, "error alert");
    expect(container.querySelector('[role="alert"]').textContent).toContain("boom");
  });

  it("fetches model aliases exactly once per expand (T29)", async () => {
    const calls = stubRoutes({
      cline: { installed: true, hasSwitchboard: true, settings: { baseUrl: "http://127.0.0.1:20128/v1", models: ["p/a"] } },
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(clineCard()));
    await settle(() => container.querySelector('button[aria-label="Remove p/a"]') !== null, "model chip rendered");
    expect(aliasCalls(calls)).toBe(1);
  });

  it("keeps user edits when Apply's status refresh returns the old server list (T30)", async () => {
    const serverStatus = { installed: true, hasSwitchboard: true, settings: { baseUrl: "http://127.0.0.1:20128/v1", models: ["p/a", "p/b"], defaultModel: "p/a" } };
    stubRoutes({ cline: serverStatus, postCline: { ok: true } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(clineCard()));
    await settle(() => container.querySelector('button[aria-label="Remove p/b"]') !== null, "chips rendered");

    await click(container.querySelector('button[aria-label="Remove p/b"]'));
    await settle(() => container.querySelector('button[aria-label="Remove p/b"]') === null, "p/b removed");

    // Apply triggers checkStatus() which returns the untouched server list.
    await click(findByLabel(container, "button", "Apply"));
    await settle(() => container.querySelector('button[aria-label="Remove p/b"]') === null, "edits preserved");
  });

  it("seeds the endpoint dropdown from the server base URL (T32)", async () => {
    stubRoutes({
      cline: { installed: true, hasSwitchboard: true, settings: { baseUrl: "https://tunnel.example.com/v1", models: ["p/a"], defaultModel: "p/a" } },
    });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(clineCard()));
    await settle(() => container.querySelector('button[aria-label="Remove p/a"]') !== null, "model chip rendered");
    const customInput = container.querySelector("input[type=text][placeholder='https://example.com/v1']");
    expect(customInput?.value).toBe("https://tunnel.example.com/v1");
    // The select must not sit on the loopback option.
    const select = container.querySelector("select");
    expect(select.value).not.toBe("local");
  });
});

describe("CodexToolCard (T28/T29/T40/T41/T42)", () => {
  const configWithTwoProviders = `model = "p/main"
model_provider = "other"

[model_providers.other]
name = "Other"
base_url = "https://other.example.com/v1"

[model_providers.switchboard]
name = "Switchboard"
base_url = "http://127.0.0.1:20128/v1"
wire_api = "responses"
`;

  it("renders the route error when codex-settings 500s (T28)", async () => {
    stubRoutes({ codex: jsonResponse({ error: "boom" }, 500) });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    await settle(() => container.querySelector('[role="alert"]') !== null, "error alert");
    expect(container.querySelector('[role="alert"]').textContent).toContain("boom");
  });

  it("fetches model aliases exactly once per expand (T29)", async () => {
    const calls = stubRoutes({ codex: { installed: true, config: configWithTwoProviders } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    await settle(() => (container.querySelector("input[type=text]")?.value || "") === "p/main", "model parsed");
    expect(aliasCalls(calls)).toBe(1);
  });

  it("badges and Current row read the switchboard section's base_url, not the first provider's (T41)", async () => {
    stubRoutes({ codex: { installed: true, config: configWithTwoProviders } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    await settle(() => container.textContent.includes("Connected"), "badge computed");
    expect(container.textContent).not.toContain("Other");
    expect(container.textContent).toContain("http://127.0.0.1:20128/v1");
    expect(container.textContent).not.toContain("https://other.example.com/v1");
  });

  it("keeps a typed model when Apply's status refresh returns the old config (T40)", async () => {
    stubRoutes({ codex: { installed: true, config: configWithTwoProviders }, postCodex: { ok: true } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    const modelInput = container.querySelector("input[type=text]");
    await settle(() => modelInput?.value === "p/main", "model parsed");
    expect(modelInput).toBeTruthy();

    await setValue(modelInput, "p/edited");
    await click(findByLabel(container, "button", "Apply"));
    await settle(() => modelInput.value === "p/edited", "edit preserved");
  });

  it("manual snippet falls back to a placeholder model instead of an empty string (T42)", async () => {
    stubRoutes({ codex: { installed: true, config: "" } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    await settle(() => findByLabel(container, "button", "Manual Config") !== null, "panel rendered");
    await click(findByLabel(container, "button", "Manual Config"));
    await settle(() => container.querySelector("pre") !== null, "manual modal open");
    const snippet = [...container.querySelectorAll("pre")].map((pre) => pre.textContent).join("\n");
    expect(snippet).toContain('model = "provider/model-id"');
    expect(snippet).not.toContain('model = ""');
  });
});

describe("CodexToolCard switchboard section parsing (T41 follow-up)", () => {
  it("reads base_url when [model_providers.switchboard] is the last section with no trailing newline", async () => {
    const config = `model = "p/main"
model_provider = "switchboard"

[model_providers.other]
base_url = "https://other.example.com/v1"

[model_providers.switchboard]
name = "Switchboard"
base_url = "http://127.0.0.1:20128/v1"`;
    stubRoutes({ codex: { installed: true, config } });
    harness = createHarness();
    const container = await harness.mount(withQueryClient(codexCard()));
    await settle(() => container.textContent.includes("Connected"), "badge computed from the last section");
    expect(container.textContent).toContain("http://127.0.0.1:20128/v1");
    expect(container.textContent).not.toContain("https://other.example.com/v1");
  });
});
