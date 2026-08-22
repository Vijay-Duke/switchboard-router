import { describe, expect, it } from "vitest";

import useThemeStore, { resolveIsDark } from "../../src/store/themeStore.js";

describe("theme store (QA-006)", () => {
  it("light theme never resolves to dark, regardless of system preference", () => {
    expect(resolveIsDark("light", true)).toBe(false);
    expect(resolveIsDark("light", false)).toBe(false);
  });

  it("dark theme always resolves to dark, regardless of system preference", () => {
    expect(resolveIsDark("dark", true)).toBe(true);
    expect(resolveIsDark("dark", false)).toBe(true);
  });

  it("system theme follows the system preference", () => {
    expect(resolveIsDark("system", true)).toBe(true);
    expect(resolveIsDark("system", false)).toBe(false);
  });

  it("toggling from dark lands on light and back", () => {
    useThemeStore.getState().setTheme("dark");
    expect(useThemeStore.getState().theme).toBe("dark");

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe("light");

    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("setTheme persists the selected theme", () => {
    useThemeStore.getState().setTheme("light");
    expect(useThemeStore.getState().theme).toBe("light");
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().theme).toBe("system");
  });
});
