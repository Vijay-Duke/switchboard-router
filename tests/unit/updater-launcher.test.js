import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";

const childProcessMock = {
  spawn: vi.fn(),
  execSync: vi.fn(),
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const updaterPath = path.join(repoRoot, "src/lib/updater/updater.js");
const cliPath = path.join(repoRoot, "cli/cli.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitForExit(child, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("detached updater lifecycle", () => {
  it("exits promptly when its status port is already occupied", async () => {
    const occupied = net.createServer();
    const port = await listen(occupied);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-updater-occupied-"));

    try {
      const startedAt = Date.now();
      const child = spawnProcess(process.execPath, [updaterPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          UPDATER_PORT: String(port),
          UPDATER_STARTUP_TIMEOUT_MS: "1000",
          UPDATER_LINGER_MS: "0",
        },
        stdio: "ignore",
      });
      const result = await waitForExit(child);
      const status = JSON.parse(fs.readFileSync(path.join(dataDir, "update", "status.json"), "utf8"));

      expect(result.code).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(status.done).toBe(true);
      expect(status.error).toContain("EADDRINUSE");
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("application updater ownership and relaunch settings", () => {
  let dataDir;
  let originalEnv;
  let appUpdater;
  let mockedSpawn;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-app-updater-"));
    process.env.DATA_DIR = dataDir;
    process.env.UPDATER_SCRIPT_PATH = updaterPath;
    process.env.PORT = "24567";
    process.env.HOST = "0.0.0.0";
    delete process.env.TRAY_MODE;

    vi.doMock("child_process", () => childProcessMock);
    vi.resetModules();
    appUpdater = await import("../../src/lib/appUpdater.js");
    mockedSpawn = childProcessMock.spawn;
    vi.clearAllMocks();
    mockedSpawn.mockReturnValue({ pid: 321, unref: vi.fn() });
    vi.spyOn(process, "exit").mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("child_process");
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("passes custom PORT and HOST to the post-update CLI relaunch", () => {
    appUpdater.spawnUpdaterAndExit("switchboard-router-test");

    const [, , options] = mockedSpawn.mock.calls[0];
    const relaunchArgs = JSON.parse(options.env.UPDATER_RELAUNCH_ARGS);

    expect(options.env.UPDATER_APP_PORT).toBe("24567");
    expect(relaunchArgs).toEqual([
      "switchboard-router",
      "--port", "24567",
      "--host", "0.0.0.0",
      "--skip-update",
    ]);
    expect(options.env.UPDATER_PKG_NAME).toBe("switchboard-router-test");
  });

  it("reads the MITM PID file from DATA_DIR", async () => {
    const pidFile = path.join(dataDir, "mitm", ".mitm.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "987654");

    await appUpdater.killAppProcesses();

    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("CLI lifecycle safety", () => {
  it("uses the tray lifecycle for a non-TTY launch without lifecycle flags", () => {
    const source = fs.readFileSync(cliPath, "utf8");

    expect(source).toContain("(!process.stdin.isTTY || !process.stdout.isTTY) && !trayMode");
    expect(source).not.toContain("if (skipUpdate && !trayMode && !process.stdin.isTTY)");
  });

  it("filters port listeners through recorded ownership before signalling", () => {
    const source = fs.readFileSync(cliPath, "utf8");

    expect(source).toContain("findListeningPids(port).filter((pid) => ownedPids.has(pid))");
    expect(source).not.toContain("execSync(`kill -9 ${pid}");
  });
});
