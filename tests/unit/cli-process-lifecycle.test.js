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
  matchesRecordedProcess,
  terminatePid,
} = require("../../cli/src/cli/processManager.js");
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
