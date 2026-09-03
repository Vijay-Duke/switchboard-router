import { createRequire } from "node:module";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

// autostart.js destructures execSync at load time, so the stub must be in
// place before the first require: enableMacOS would otherwise register a
// real LaunchAgent (pointing at a temp dir) in the developer's launchd session.
const execSync = vi.spyOn(childProcess, "execSync").mockReturnValue("");
const autostart = require("../../cli/src/cli/tray/autostart.js");

const APP_LABEL = "com.switchboard.autostart";

describe.runIf(process.platform === "darwin")("macOS autostart plist", () => {
  it("writes launcher logs under the data dir instead of /tmp and honours DATA_DIR", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-"));
    // Spaces and an ampersand exercise XML escaping of every path we write.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb autostart & data-"));
    const cliJs = path.join(dataDir, "cli.js");
    fs.writeFileSync(cliJs, "");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    const prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    try {
      expect(autostart.enableAutoStart(cliJs, { port: 20128, host: "127.0.0.1" })).toBe(true);
      const plistPath = path.join(home, "Library", "LaunchAgents", `${APP_LABEL}.plist`);
      const plist = fs.readFileSync(plistPath, "utf8");
      const escapedDataDir = dataDir.replace(/&/g, "&amp;");
      expect(plist).not.toContain("/tmp/");
      expect(plist).not.toContain(`<string>${dataDir}</string>`);
      expect(plist).toContain(`<string>${path.join(escapedDataDir, "logs", "launcher.log")}</string>`);
      expect(plist).toContain(`<string>${path.join(escapedDataDir, "logs", "launcher.error.log")}</string>`);
      expect(plist).toContain(`<key>DATA_DIR</key>\n        <string>${escapedDataDir}</string>`);
      expect(plist).toMatch(/<key>PATH<\/key>\s*<string>[^<]*:\/usr\/sbin:\/sbin<\/string>/);
      expect(fs.statSync(path.join(dataDir, "logs")).mode & 0o777).toBe(0o700);
      // launchctl was reached only through the stub.
      const launchctlCalls = execSync.mock.calls.map(([cmd]) => String(cmd)).filter((cmd) => cmd.startsWith("launchctl"));
      expect(launchctlCalls.length).toBeGreaterThan(0);
    } finally {
      homedir.mockRestore();
      if (prevDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevDataDir;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
