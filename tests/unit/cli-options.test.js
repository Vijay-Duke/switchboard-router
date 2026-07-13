import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { formatHelp, isLoopbackHost, parseCliArgs } = require("../../cli/src/cli/cliOptions.js");
const { probeSwitchboard, waitForSwitchboard } = require("../../cli/src/cli/serverStatus.js");
const { getLaunchArgs } = require("../../cli/src/cli/tray/autostart.js");
const { renderHeader } = require("../../cli/src/cli/terminalUI.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "cli", "cli.js");

describe("CLI option contract", () => {
  it("supports explicit lifecycle commands and validated launch options", () => {
    expect(parseCliArgs(["restart", "--port", "24567", "--host", "0.0.0.0", "--log"])).toMatchObject({
      command: "restart",
      port: 24567,
      host: "0.0.0.0",
      showLog: true,
    });
    expect(parseCliArgs(["status", "--json"])).toMatchObject({ command: "status", json: true });
    expect(parseCliArgs(["stop"])).toMatchObject({ command: "stop" });
  });

  it.each([
    [["--port"], "requires a value"],
    [["--port", "0"], "between 1 and 65535"],
    [["--port", "65536"], "between 1 and 65535"],
    [["--port", "abc"], "between 1 and 65535"],
    [["--host"], "requires a value"],
    [["--host", "http://localhost"], "hostname or IP address"],
    [["--host", "local host"], "hostname or IP address"],
    [["--unknown"], "Unknown option"],
    [["launch"], "Unknown command"],
    [["stop", "--tray"], "not valid with"],
    [["start", "--json"], "only valid with"],
  ])("rejects malformed invocation %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it("documents lifecycle commands, graceful shutdown, recovery, and every supported option", () => {
    const help = formatHelp({ version: "9.9.9" });

    for (const text of [
      "switchboard status",
      "switchboard stop",
      "switchboard restart",
      "Ctrl+C",
      "gracefully",
      "--port",
      "--host",
      "--log",
      "--tray",
      "--skip-update",
      "--no-browser",
      "--json",
      "9.9.9",
    ]) {
      expect(help).toContain(text);
    }
  });

  it("keeps help and version side-effect-free before runtime initialization", () => {
    const dataDir = path.join(os.tmpdir(), `switchboard-help-${process.pid}-${Date.now()}`);
    const help = execFileSync(process.execPath, [cliPath, "--help"], {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
    });

    expect(help).toContain("switchboard restart");
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("returns stable status and validation exit codes", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-cli-status-"));
    try {
      const stopped = spawnSync(process.execPath, [cliPath, "status", "--port", "29998"], {
        cwd: repoRoot,
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: "utf8",
      });
      expect(stopped.status).toBe(3);
      expect(stopped.stdout).toContain("not running");

      const invalid = spawnSync(process.execPath, [cliPath, "--port", "65536"], {
        cwd: repoRoot,
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: "utf8",
      });
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("between 1 and 65535");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves host and port through autostart relaunch arguments", () => {
    expect(getLaunchArgs({ port: 24567, host: "0.0.0.0" })).toEqual([
      "--tray", "--skip-update", "--port", "24567", "--host", "0.0.0.0",
    ]);
  });

  it("renders truthful endpoint exposure in the terminal UI", () => {
    expect(renderHeader(24567, [], { networkExposed: true })).toContain("network-exposed");
    expect(renderHeader(24567, [], { networkExposed: false })).toContain("local only");
    expect(renderHeader(24567, [], {})).toContain("localhost:24567");
  });

  it("classifies wildcard and specific LAN binds as network-exposed", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("switchboard.lan")).toBe(false);
  });

  it("probes the configured bind host instead of assuming 127.0.0.1", async () => {
    const lanHost = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries || [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (!lanHost) return;
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { name: "switchboard-app", version: "1.2.3" } }));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, lanHost, resolve);
    });
    try {
      const result = await probeSwitchboard(server.address().port, 1000, lanHost);
      expect(result).toMatchObject({ name: "switchboard-app", version: "1.2.3" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("accepts TCP readiness only when the caller verifies listener ownership", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 403;
      res.end("local-only management route");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const rejected = await waitForSwitchboard(server.address().port, {
        timeoutMs: 100,
        intervalMs: 25,
      });
      expect(rejected).toBeNull();

      const accepted = await waitForSwitchboard(server.address().port, {
        timeoutMs: 500,
        intervalMs: 25,
        acceptTcpFallback: async () => true,
      });
      expect(accepted).toMatchObject({ name: "switchboard-app", tcpOnly: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
