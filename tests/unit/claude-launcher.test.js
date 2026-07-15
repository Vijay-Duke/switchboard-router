import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  buildClaudeLaunchArgs,
  buildClaudeSpawnOptions,
  getClaudeFullCatalogProfilePath,
} = require("../../cli/src/cli/claudeLauncher.js");

describe("claude-switchboard launcher", () => {
  it("launches Claude with the dedicated full-catalog settings at command-line precedence", () => {
    const dataDir = path.join("tmp", "switchboard data");
    const profilePath = getClaudeFullCatalogProfilePath(dataDir);

    expect(profilePath).toBe(path.join(dataDir, "claude-code", "full-catalog-settings.json"));
    expect(buildClaudeLaunchArgs(profilePath, ["--continue", "hello"])).toEqual([
      "--settings",
      profilePath,
      "--continue",
      "hello",
    ]);
  });

  it("uses the command shell only where npm command shims require it", () => {
    expect(buildClaudeSpawnOptions("win32").shell).toBe(true);
    expect(buildClaudeSpawnOptions("darwin").shell).toBe(false);
    expect(buildClaudeSpawnOptions("linux").shell).toBe(false);
  });
});
