const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getDataDir } = require("../shared/dataDir");

function getClaudeFullCatalogProfilePath(dataDir = getDataDir()) {
  return path.join(dataDir, "claude-code", "full-catalog-settings.json");
}

function buildClaudeLaunchArgs(settingsPath, args = []) {
  return ["--settings", settingsPath, ...args];
}

function buildClaudeSpawnOptions(platform = process.platform) {
  return {
    stdio: "inherit",
    env: process.env,
    // npm installs command shims as .cmd files on Windows. Those need cmd.exe
    // for PATHEXT resolution; macOS/Linux can execute the shim directly.
    shell: platform === "win32",
  };
}

function runClaudeSwitchboard(args = process.argv.slice(2)) {
  const settingsPath = getClaudeFullCatalogProfilePath();
  if (!fs.existsSync(settingsPath)) {
    console.error("Claude full-catalog profile is not configured. Open Switchboard → CLI Tools → Claude Code and save Full Switchboard Catalog first.");
    return 1;
  }
  const result = spawnSync(
    "claude",
    buildClaudeLaunchArgs(settingsPath, args),
    buildClaudeSpawnOptions(),
  );
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error("Claude Code is not installed or is not available on PATH.");
      return 127;
    }
    console.error(`Failed to launch Claude Code: ${result.error.message}`);
    return 1;
  }
  return typeof result.status === "number" ? result.status : 1;
}

module.exports = {
  buildClaudeLaunchArgs,
  buildClaudeSpawnOptions,
  getClaudeFullCatalogProfilePath,
  runClaudeSwitchboard,
};
