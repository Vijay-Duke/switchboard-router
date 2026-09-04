// @vitest-environment happy-dom
// T39: CodexToolCard local apply must send apiKey "sk_switchboard" when no
// dashboard key is selected and cloud is off, then surface success.

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, click, jsonResponse, settle, setValue, withQueryClient } from "./dashboard-dom-harness.js";
import { findByLabel } from "./dashboard-dom-harness.js";
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

it("sends sk_switchboard for a local apply with no dashboard key (T39)", async () => {
  const bodies = [];
  const config = `model = "p/main"

[model_providers.switchboard]
name = "Switchboard"
base_url = "http://127.0.0.1:20128/v1"
wire_api = "responses"
`;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const urlStr = String(url);
    if (urlStr === "/api/cli-tools/codex-settings" && init?.method === "POST") {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ success: true });
    }
    if (urlStr === "/api/cli-tools/codex-settings") return jsonResponse({ installed: true, config });
    if (urlStr === "/api/models/alias") return jsonResponse({ aliases: {} });
    return jsonResponse({});
  }));
  harness = createHarness();
  const container = await harness.mount(withQueryClient(h(CodexToolCard, {
    tool: CLI_TOOLS.codex,
    isExpanded: true,
    onToggle: () => {},
    baseUrl: "http://127.0.0.1:20128",
    apiKeys: [], // no dashboard key selected
    activeProviders: [],
    cloudEnabled: false,
  })));
  const modelInput = container.querySelector("input[type=text]");
  await settle(() => modelInput?.value === "p/main", "model parsed");

  await setValue(modelInput, "p/chosen");
  await click(findByLabel(container, "button", "Apply"));
  await settle(() => bodies.length === 1, "apply posted");
  expect(bodies[0].apiKey).toBe("sk_switchboard");
  expect(bodies[0].model).toBe("p/chosen");
  await settle(() => container.textContent.includes("Settings applied successfully!"), "success message");
});
