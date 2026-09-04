// @vitest-environment happy-dom
// T33/T34: ClineToolCard's Manual Config must mirror the Apply route's
// providers.json / models.json / globalState.json payloads.

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, click, jsonResponse, settle, withQueryClient } from "./dashboard-dom-harness.js";
import { findByLabel, findByText } from "./dashboard-dom-harness.js";
import ClineToolCard from "../../src/app/(dashboard)/dashboard/cli-tools/components/ClineToolCard.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const h = React.createElement;

vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

function stubRoutes(status) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const urlStr = String(url);
    if (urlStr === "/api/cli-tools/cline-settings") return jsonResponse(status);
    if (urlStr === "/api/models/alias") return jsonResponse({ aliases: {} });
    return jsonResponse({});
  }));
}

async function mountCline() {
  await harness.mount(withQueryClient(h(ClineToolCard, {
    tool: CLI_TOOLS.cline,
    isExpanded: true,
    onToggle: () => {},
    baseUrl: "http://127.0.0.1:20128",
    apiKeys: [{ keySecret: "sk_test", keyPrefix: "sk_t…" }],
    activeProviders: [],
    cloudEnabled: false,
  })));
}

/** Parse the modal's pre blocks keyed by the filename shown above each. */
function readManualConfigs(container) {
  const pres = [...container.querySelectorAll("pre")];
  const filenames = [...container.querySelectorAll("span")]
    .filter((el) => el.textContent.startsWith("~/.cline/"))
    .map((el) => el.textContent.trim());
  expect(pres.length).toBe(filenames.length);
  return Object.fromEntries(pres.map((pre, i) => [filenames[i], JSON.parse(pre.textContent)]));
}

describe("ClineToolCard manual configs (T33/T34)", () => {
  it("mirrors the Apply route across providers.json, models.json and globalState.json", async () => {
    stubRoutes({
      installed: true,
      hasSwitchboard: true,
      settings: {
        baseUrl: "http://127.0.0.1:20128/v1",
        models: ["p/a", "p/b"],
        defaultModel: "p/a",
      },
    });
    harness = createHarness();
    await mountCline();
    const c = harness.container;
    await settle(() => findByText(c, "span", "p/b") !== null, "chips rendered");
    await click(findByLabel(c, "button", "Manual Config"));
    await settle(() => c.querySelector("pre") !== null, "manual modal open");

    const configs = readManualConfigs(c);
    const url = "http://127.0.0.1:20128/v1";

    // providers.json — route shape for the switchboard entry.
    expect(configs["~/.cline/data/settings/providers.json"].providers.switchboard).toEqual({
      type: "openai-compatible",
      name: "Switchboard",
      baseUrl: url,
      apiKey: "sk_test",
      defaultModelId: "p/a",
    });

    // models.json — mirrors the same models + endpoint the Apply route writes.
    const modelsEntry = configs["~/.cline/data/settings/models.json"].providers.switchboard;
    expect(modelsEntry.provider).toEqual({ name: "Switchboard", baseUrl: url, defaultModelId: "p/a" });
    expect(Object.keys(modelsEntry.models)).toEqual(["p/a", "p/b"]);

    // globalState.json — the five legacy keys the Apply route syncs.
    const globalState = configs["~/.cline/data/globalState.json"];
    expect(globalState).toEqual({
      actModeApiProvider: "openai",
      planModeApiProvider: "openai",
      openAiBaseUrl: url,
      actModeOpenAiModelId: "p/a",
      planModeOpenAiModelId: "p/a",
    });
  });
});
