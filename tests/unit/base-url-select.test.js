// @vitest-environment happy-dom
// T26/T27: BaseUrlSelect must honor a server-configured endpoint on mount
// instead of forcing 127.0.0.1, and the endpoint <select> needs a label.

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { createHarness, jsonResponse } from "./dashboard-dom-harness.js";
import BaseUrlSelect from "../../src/app/(dashboard)/dashboard/cli-tools/components/BaseUrlSelect.js";
import { UPDATER_CONFIG } from "../../src/shared/constants/config.js";

const h = React.createElement;
const LOCAL_URL = `http://127.0.0.1:${UPDATER_CONFIG.appPort}/v1`;

vi.mock("next/image", () => ({ default: (props) => h("img", props) }));

let harness = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.unstubAllGlobals();
});

function mountSelect({ initialUrl, onChange = vi.fn() }) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
  harness = createHarness();
  return {
    onChange,
    async mount() {
      await harness.mount(h(BaseUrlSelect, {
        value: "",
        onChange,
        initialUrl,
        tunnelPublicUrl: "https://tunnel.example.com",
      }));
      return harness.container;
    },
  };
}

describe("BaseUrlSelect (T26/T27)", () => {
  it("selects the option matching initialUrl instead of forcing local", async () => {
    const { onChange, mount } = mountSelect({ initialUrl: LOCAL_URL });
    const container = await mount();
    const select = container.querySelector("select");
    expect(select.value).toBe("local");
    expect(onChange).toHaveBeenCalledWith(LOCAL_URL);
  });

  it("keeps a non-preset server URL in custom mode — never repoints to local", async () => {
    const { onChange, mount } = mountSelect({ initialUrl: "https://tunnel.example.com" });
    const container = await mount();
    const input = container.querySelector("input[type=text]");
    expect(input.value).toBe("https://tunnel.example.com");
    expect(onChange).toHaveBeenCalledWith("https://tunnel.example.com/v1");
    const calls = onChange.mock.calls.map(([url]) => url);
    expect(calls.some((url) => url.includes("127.0.0.1"))).toBe(false);
  });

  it("defaults to the first option (loopback) when no initialUrl is given", async () => {
    const { onChange, mount } = mountSelect({ initialUrl: "" });
    const container = await mount();
    const select = container.querySelector("select");
    expect(select.value).toBe("local");
    expect(onChange).toHaveBeenCalledWith(LOCAL_URL);
  });

  it("exposes an accessible label on the endpoint select (T27)", async () => {
    const { mount } = mountSelect({ initialUrl: "" });
    const container = await mount();
    const select = container.querySelector("select");
    expect(select.getAttribute("aria-label")).toBe("Select Endpoint");
  });
});
