import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildInterfaceMenuItems, ensureTrayReady } = require("../../cli/src/cli/interfaceMenu.js");

describe("interface menu", () => {
  it("keeps tray mode discoverable when the tray helper needs a retry", () => {
    expect(buildInterfaceMenuItems({ trayAvailable: false })).toMatchObject([
      { action: "web" },
      { action: "terminal" },
      { action: "hide", label: "Hide to Tray (Retry)" },
      { action: "exit" },
    ]);
    expect(buildInterfaceMenuItems({ trayAvailable: false }).map(({ action }) => action)).toEqual([
      "web",
      "terminal",
      "hide",
      "exit",
    ]);
  });

  it("keeps update and tray actions when both are available", () => {
    expect(
      buildInterfaceMenuItems({ latestVersion: "9.9.9", currentVersion: "1.2.3", trayAvailable: true }),
    ).toMatchObject([
      { action: "update", label: "Update to v9.9.9 (current: v1.2.3)" },
      { action: "web" },
      { action: "terminal" },
      { action: "hide" },
      { action: "exit" },
    ]);
  });

  it("retries tray startup only when the initial attempt was unavailable", async () => {
    const initTray = vi.fn(async () => true);

    await expect(ensureTrayReady(true, initTray)).resolves.toBe(true);
    expect(initTray).not.toHaveBeenCalled();

    await expect(ensureTrayReady(false, initTray)).resolves.toBe(true);
    expect(initTray).toHaveBeenCalledOnce();
  });

  it("reports a failed tray retry without treating it as ready", async () => {
    const initTray = vi.fn(async () => false);

    await expect(ensureTrayReady(false, initTray)).resolves.toBe(false);
    expect(initTray).toHaveBeenCalledOnce();
  });
});
