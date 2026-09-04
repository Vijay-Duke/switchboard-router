import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildInterfaceMenuItems, mapInterfaceSelection } = require("../../cli/src/cli/interfaceMenu.js");

describe("mapInterfaceSelection (L13)", () => {
  const items = buildInterfaceMenuItems({ currentVersion: "1.0.0", trayAvailable: true });

  it("maps ESC (-1) to back instead of exit", () => {
    expect(mapInterfaceSelection(items, -1)).toBe("back");
  });

  it("maps out-of-range indexes to back", () => {
    expect(mapInterfaceSelection(items, 99)).toBe("back");
    expect(mapInterfaceSelection(items, items.length)).toBe("back");
  });

  it("maps valid indexes to their actions", () => {
    expect(mapInterfaceSelection(items, 0)).toBe("web");
    expect(mapInterfaceSelection(items, 1)).toBe("terminal");
    const actions = items.map((_, i) => mapInterfaceSelection(items, i));
    expect(actions).toContain("web");
    expect(actions).toContain("terminal");
    expect(actions).toContain("exit");
  });

  it("treats non-array input as back", () => {
    expect(mapInterfaceSelection(null, 0)).toBe("back");
  });
});
