import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";

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

async function waitForFile(file, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file did not appear within ${timeoutMs}ms: ${file}`);
}

describe("detached updater lifecycle", () => {
  it("publishes a per-launch readiness token only after the status server binds", async () => {
    const app = net.createServer();
    const appPort = await listen(app);
    const statusProbe = net.createServer();
    const statusPort = await listen(statusProbe);
    await new Promise((resolve) => statusProbe.close(resolve));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-updater-ready-"));
    const readyFile = path.join(dataDir, "update", "ready-token");
    const token = "expected-ready-token";
    const child = spawnProcess(process.execPath, [updaterPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        UPDATER_PORT: String(statusPort),
        UPDATER_APP_PORT: String(appPort),
        UPDATER_READY_FILE: readyFile,
        UPDATER_READY_TOKEN: token,
        UPDATER_WAIT_MIN_MS: "10000",
        UPDATER_WAIT_MAX_MS: "11000",
        UPDATER_LINGER_MS: "0",
      },
      stdio: "ignore",
    });

    try {
      await expect(waitForFile(readyFile)).resolves.toBe(token);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => {});
      await new Promise((resolve) => app.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

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

  it("settles each failed npm spawn once before retrying", async () => {
    const statusProbe = net.createServer();
    const statusPort = await listen(statusProbe);
    await new Promise((resolve) => statusProbe.close(resolve));
    const appProbe = net.createServer();
    const appPort = await listen(appProbe);
    await new Promise((resolve) => appProbe.close(resolve));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-updater-spawn-error-"));
    const child = spawnProcess(process.execPath, [updaterPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: "",
        DATA_DIR: dataDir,
        UPDATER_PORT: String(statusPort),
        UPDATER_APP_PORT: String(appPort),
        UPDATER_RETRIES: "2",
        UPDATER_RETRY_DELAY_MS: "0",
        UPDATER_WAIT_MIN_MS: "0",
        UPDATER_WAIT_MAX_MS: "0",
        UPDATER_LINGER_MS: "0",
      },
      stdio: "ignore",
    });

    try {
      const result = await waitForExit(child);
      const status = JSON.parse(fs.readFileSync(path.join(dataDir, "update", "status.json"), "utf8"));
      expect(result.code).toBe(1);
      expect(status.attempt).toBe(2);
      expect(status.done).toBe(true);
      expect(status.error).toContain("ENOENT");
    } finally {
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
    mockedSpawn.mockImplementation(() => Object.assign(new EventEmitter(), {
      pid: 321,
      unref: vi.fn(),
      kill: vi.fn(),
    }));
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

  it("passes custom PORT and HOST to the post-update CLI relaunch", async () => {
    const startup = appUpdater.spawnUpdaterAndExit("switchboard-router-test");

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
    fs.mkdirSync(path.dirname(options.env.UPDATER_READY_FILE), { recursive: true });
    fs.writeFileSync(options.env.UPDATER_READY_FILE, options.env.UPDATER_READY_TOKEN);
    await vi.advanceTimersByTimeAsync(100);
    await expect(startup).resolves.toEqual({ started: true });
  });

  it("keeps the current app alive when the updater never becomes ready", async () => {
    const exit = vi.mocked(process.exit);
    const startup = appUpdater.spawnUpdaterAndExit("switchboard-router-test");
    const updater = mockedSpawn.mock.results[0].value;

    await vi.advanceTimersByTimeAsync(3100);

    await expect(startup).resolves.toMatchObject({ started: false });
    expect(updater.kill).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports updater spawn failures without exiting the current app", async () => {
    mockedSpawn.mockImplementationOnce(() => { throw new Error("spawn unavailable"); });

    await expect(appUpdater.spawnUpdaterAndExit("switchboard-router-test")).resolves.toEqual({
      started: false,
      error: "Could not start updater: spawn unavailable",
    });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("handles asynchronous updater process errors without crashing", async () => {
    const updater = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn(), kill: vi.fn() });
    mockedSpawn.mockReturnValueOnce(updater);
    const startup = appUpdater.spawnUpdaterAndExit("switchboard-router-test");

    updater.emit("error", new Error("node executable unavailable"));
    await vi.advanceTimersByTimeAsync(50);

    await expect(startup).resolves.toEqual({
      started: false,
      error: "Updater process failed before readiness.",
    });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("preserves an unverifiable MITM PID file instead of signalling a reused PID", async () => {
    const pidFile = path.join(dataDir, "mitm", ".mitm.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "987654");

    await appUpdater.killAppProcesses();

    expect(fs.existsSync(pidFile)).toBe(true);
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

    expect(source).toContain("const pids = listeningPids.filter((pid) => ownedPids.has(pid));");
    expect(source).not.toContain("execSync(`kill -9 ${pid}");
  });
});
