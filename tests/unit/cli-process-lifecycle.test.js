import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  acquireLifecycleLock,
  childIsLive,
  matchesRecordedProcess,
  nextRestartDelay,
  observeChildExit,
  shouldAbandonRestarts,
  shouldPrintCrashLog,
  terminateOrphanedGroup,
  terminatePid,
} = require("../../cli/src/cli/processManager.js");
const { startHealthWatchdog } = require("../../cli/src/cli/serverStatus.js");
const {
  requestGracefulInterrupt,
} = require("../../cli/src/cli/utils/input.js");
import { matchesRecordedProcess as matchesUpdaterProcess } from "../../src/lib/processIdentity.js";

describe("CLI process identity", () => {
  const serverPath = "/opt/switchboard-router/app/custom-server.js";

  it("recognizes a recorded server after Next replaces its process title", () => {
    const identity = {
      command: "next-server (v16.2.10)",
      cwd: path.dirname(serverPath),
      expectedPath: serverPath,
    };
    expect(matchesRecordedProcess(identity)).toBe(true);
    expect(matchesUpdaterProcess(identity)).toBe(true);
  });

  it("rejects an unrelated Next server with the same process title", () => {
    expect(matchesRecordedProcess({
      command: "next-server (v16.2.10)",
      cwd: "/Users/example/another-app",
      expectedPath: serverPath,
    })).toBe(false);
  });

  it("keeps exact command-path matching for CLI and server processes", () => {
    expect(matchesRecordedProcess({
      command: `/usr/bin/node ${serverPath}`,
      cwd: "/tmp",
      expectedPath: serverPath,
    })).toBe(true);
  });

  it("recognizes a recorded CLI launched through a relative script path", () => {
    expect(matchesRecordedProcess({
      command: "node cli/cli.js start --tray",
      cwd: "/Users/example/switchboard",
      expectedPath: "/Users/example/switchboard/cli/cli.js",
    })).toBe(true);
  });

  it.runIf(process.platform !== "win32")("recognizes a CLI launched through its npm symlink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cli-link-"));
    const cliPath = path.join(dir, "cli.js");
    const binPath = path.join(dir, "switchboard");
    try {
      fs.writeFileSync(cliPath, "");
      fs.symlinkSync(cliPath, binPath);
      expect(matchesRecordedProcess({
        command: `node ${binPath} start`,
        cwd: dir,
        expectedPath: cliPath,
      })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects command arguments that only contain the recorded path as a substring", () => {
    const identity = {
      command: `/usr/bin/node ${serverPath}.backup`,
      cwd: "/tmp",
      expectedPath: serverPath,
    };
    expect(matchesRecordedProcess(identity)).toBe(false);
    expect(matchesUpdaterProcess(identity)).toBe(false);
  });

  it("rejects an editor that merely has the recorded script open", () => {
    const identity = {
      command: `/usr/bin/vim ${serverPath}`,
      cwd: "/tmp",
      expectedPath: serverPath,
    };
    expect(matchesRecordedProcess(identity)).toBe(false);
    expect(matchesUpdaterProcess(identity)).toBe(false);
  });
});

describe("CLI lifecycle serialization", () => {
  it("allows only one mutating lifecycle operation at a time", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-lifecycle-lock-"));
    try {
      const releaseFirst = await acquireLifecycleLock(dataDir, { instanceId: "first", timeoutMs: 1000 });
      let secondAcquired = false;
      const second = acquireLifecycleLock(dataDir, { instanceId: "second", timeoutMs: 1000 }).then((release) => {
        secondAcquired = true;
        return release;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(secondAcquired).toBe(false);
      releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      releaseSecond();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("terminates the complete detached server process group", async () => {
    const parent = spawn(process.execPath, ["-e", `
      const { spawn } = require("child_process");
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await terminatePid(parent.pid, { processGroup: true, timeoutMs: 1500 })).toBe(true);
      expect(() => process.kill(-parent.pid, 0)).toThrow();
    } finally {
      try { process.kill(-parent.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  });
});

  it.runIf(process.platform !== "win32")("sweeps grandchildren left behind by an exited detached child", async () => {
    // sh exits immediately; the backgrounded sleep stays in sh's process group.
    const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => leader.once("exit", resolve));
      expect(leader.exitCode).toBe(0);
      expect(() => process.kill(-leader.pid, 0)).not.toThrow();
      await expect(terminateOrphanedGroup(leader.pid, { timeoutMs: 1500 })).resolves.toBe(true);
      expect(() => process.kill(-leader.pid, 0)).toThrow();
    } finally {
      try { process.kill(-leader.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  });

  it("leaves a live PID alone because the OS may have reused it", async () => {
    await expect(terminateOrphanedGroup(process.pid)).resolves.toBe(true);
    await expect(terminateOrphanedGroup(undefined)).resolves.toBe(true);
  });

  it.runIf(process.platform !== "win32")("confirms a stopped child is dead after forced termination", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(child.pid, "SIGSTOP");
      await expect(terminatePid(child.pid, { processGroup: true, timeoutMs: 1000 })).resolves.toBe(true);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  });

describe("server child lifecycle", () => {
  it("observes exit without waiting for inherited stdio to close", () => {
    const child = new EventEmitter();
    const terminal = vi.fn();
    observeChildExit(child, terminal);

    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");

    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith(null, "SIGKILL", null);
  });
});

  it("keeps restart attempts bounded in time but unlimited in count", () => {
    expect([0, 1, 2, 3, 4, 5, 100].map(nextRestartDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

describe("restart abandonment", () => {
  it.each([
    [{ consecutiveCrashes: 5, everHealthy: false }, true],
    [{ consecutiveCrashes: 4, everHealthy: false }, false],
    [{ consecutiveCrashes: 100, everHealthy: true }, false],
    [{ consecutiveCrashes: 6, everHealthy: false }, true],
    [{ consecutiveCrashes: 0, everHealthy: false }, false],
    [{ consecutiveCrashes: 2, everHealthy: false, maxBootFailures: 2 }, true],
  ])("abandons restarts only for never-healthy repeat crashes: %j", (input, expected) => {
    expect(shouldAbandonRestarts(input)).toBe(expected);
  });
});

describe("child liveness", () => {
  it.each([
    [{ pid: 1, exitCode: null, signalCode: null }, true],
    [{ pid: 1, exitCode: 0, signalCode: null }, false],
    [{ pid: 1, exitCode: 1, signalCode: null }, false],
    [{ pid: 1, exitCode: null, signalCode: "SIGTERM" }, false],
    [{ pid: undefined, exitCode: null, signalCode: null }, false],
    [null, false],
    [undefined, false],
  ])("reports whether a child may still be signalled: %j", (child, expected) => {
    expect(childIsLive(child)).toBe(expected);
  });
});

describe("crash log suppression", () => {
  it("prints on the first attempt and whenever the log changes", () => {
    expect(shouldPrintCrashLog(1, ["boom"], "")).toBe(true);
    expect(shouldPrintCrashLog(2, ["boom"], "boom")).toBe(false);
    expect(shouldPrintCrashLog(2, ["boom", "worse"], "boom")).toBe(true);
  });

  it("stays quiet after 10 consecutive crashes", () => {
    expect(shouldPrintCrashLog(10, ["boom"], "")).toBe(true);
    expect(shouldPrintCrashLog(11, ["boom"], "")).toBe(false);
    expect(shouldPrintCrashLog(11, ["changed"], "boom")).toBe(false);
  });

  it("prints nothing without a crash log", () => {
    expect(shouldPrintCrashLog(1, [], "")).toBe(false);
  });
});

describe("watchdog callback failures", () => {
  it("keeps probing after onUnhealthy throws", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = vi.fn().mockResolvedValue(null);
    const onUnhealthy = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const stop = startHealthWatchdog({
      port: 20128,
      graceMs: 0,
      intervalMs: 10,
      timeoutMs: 1,
      maxFailures: 1,
      probe,
      onUnhealthy,
    });

    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(onUnhealthy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith("[watchdog] onUnhealthy failed:", "boom");
    } finally {
      stop();
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  it("keeps probing after onHealthy throws", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = vi.fn().mockResolvedValue(true);
    const onHealthy = vi.fn().mockRejectedValueOnce(new Error("ouch")).mockResolvedValue(undefined);
    const stop = startHealthWatchdog({
      port: 20128,
      graceMs: 0,
      intervalMs: 10,
      timeoutMs: 1,
      probe,
      onHealthy,
    });

    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(errorSpy).toHaveBeenCalledWith("[watchdog] onHealthy failed:", "ouch");
    } finally {
      stop();
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });
});

describe("terminal interrupts", () => {
  it("routes Ctrl+C through the registered SIGINT shutdown handler", () => {
    const processLike = new EventEmitter();
    processLike.exit = vi.fn();
    const shutdown = vi.fn();
    processLike.on("SIGINT", shutdown);

    requestGracefulInterrupt(processLike);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(processLike.exit).not.toHaveBeenCalled();
  });

  it("uses exit code 130 only when no lifecycle handler is registered", () => {
    const processLike = new EventEmitter();
    processLike.exit = vi.fn();

    requestGracefulInterrupt(processLike);

    expect(processLike.exit).toHaveBeenCalledWith(130);
  });
});
