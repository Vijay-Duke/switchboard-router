import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildInterfaceMenuItems } = require("../../cli/src/cli/interfaceMenu.js");

describe("interface menu", () => {
  it("omits tray mode when the tray helper is unavailable", () => {
    expect(buildInterfaceMenuItems({ trayAvailable: false }).map(({ action }) => action)).toEqual([
      "web",
      "terminal",
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
});
