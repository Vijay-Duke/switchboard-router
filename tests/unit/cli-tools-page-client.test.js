// @vitest-environment happy-dom
// T20: a failed /api/cli-tools/all-statuses must surface an error banner with
// Retry, not silently render every tool as "Not detected".

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, click, jsonResponse, settle } from "./dashboard-dom-harness.js";
import CLIToolsPageClient from "../../src/app/(dashboard)/dashboard/cli-tools/CLIToolsPageClient.js";
import { findByLabel, findByText } from "./dashboard-dom-harness.js";

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

function stubFetch(responses) {
  const fetchMock = vi.fn(async (url) => {
    const entry = responses.find((r) => r.url === url);
    return entry ? entry.response : jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CLIToolsPageClient load errors (T20)", () => {
  it("renders an alert with Retry when all-statuses fails", async () => {
    stubFetch([{ url: "/api/cli-tools/all-statuses", response: jsonResponse({ error: "boom" }, 500) }]);
    harness = createHarness();
    const container = await harness.mount(h(CLIToolsPageClient, {}));
    await settle(() => container.querySelector('[role="alert"]') !== null, "alert banner");
    const alert = container.querySelector('[role="alert"]');
    expect(alert.textContent).toContain("boom");
    // Cards degrade honestly: unknown tool shows "Not detected", not silent success.
    expect(findByText(container, "span", "Not detected")).toBeTruthy();
  });

  it("clears the banner and loads statuses after Retry succeeds", async () => {
    let failing = true;
    const fetchMock = vi.fn(async () => (
      failing
        ? jsonResponse({ error: "nope" }, 500)
        : jsonResponse({ cline: { installed: true, hasSwitchboard: true } })
    ));
    vi.stubGlobal("fetch", fetchMock);
    harness = createHarness();
    const container = await harness.mount(h(CLIToolsPageClient, {}));
    await settle(() => container.querySelector('[role="alert"]') !== null, "alert banner");

    failing = false;
    await click(findByLabel(container, "button", "Retry"));
    await settle(() => container.querySelector('[role="alert"]') === null, "banner cleared");
    expect(findByText(container, "span", "Connected")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
