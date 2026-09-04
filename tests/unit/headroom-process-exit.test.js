import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-proc-test-"));

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: TEST_DATA_DIR,
  getDataDir: () => TEST_DATA_DIR,
}));
vi.mock("../../src/lib/headroom/detect.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findHeadroomBinary: () => "/fake/headroom-bin" };
});

const { startHeadroomProxy } = await import("../../src/lib/headroom/process.js");

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
  }

  unref() {}
}

const pidFile = () => path.join(TEST_DATA_DIR, "headroom", "proxy.pid");

beforeEach(() => {
  mocks.spawn.mockReset();
  try { fs.unlinkSync(pidFile()); } catch { /* absent */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("headroom startHeadroomProxy exit listener (L8)", () => {
  it("removes the stale exit listener on success; late exit is a no-op", async () => {
    const child = new FakeChild(process.pid);
    mocks.spawn.mockReturnValue(child);

    const res = await startHeadroomProxy({ startupTimeoutMs: 20 });
    expect(res).toMatchObject({ pid: process.pid, alreadyRunning: false });
    expect(child.listenerCount("exit")).toBe(0);
    expect(fs.readFileSync(pidFile(), "utf8")).toBe(String(process.pid));

    expect(() => child.emit("exit", 0)).not.toThrow();
    expect(fs.existsSync(pidFile())).toBe(true);
    expect(fs.readFileSync(pidFile(), "utf8")).toBe(String(process.pid));
  });

  it("clears its own pid file on early exit", async () => {
    const child = new FakeChild(process.pid);
    mocks.spawn.mockReturnValue(child);

    const pending = startHeadroomProxy({ startupTimeoutMs: 50 });
    child.emit("exit", 1);
    await expect(pending).rejects.toMatchObject({ code: "EARLY_EXIT" });
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it("preserves a successor pid file on early exit", async () => {
    const child = new FakeChild(process.pid);
    mocks.spawn.mockReturnValue(child);

    const pending = startHeadroomProxy({ startupTimeoutMs: 50 });
    fs.writeFileSync(pidFile(), "424242");
    child.emit("exit", 1);
    await expect(pending).rejects.toMatchObject({ code: "EARLY_EXIT" });
    expect(fs.readFileSync(pidFile(), "utf8")).toBe("424242");
  });
});

describe("headroom startHeadroomProxy concurrency (L9)", () => {
  it("serializes concurrent starts into a single spawn", async () => {
    const child = new FakeChild(process.pid);
    mocks.spawn.mockReturnValue(child);

    const [a, b] = await Promise.all([
      startHeadroomProxy({ startupTimeoutMs: 20 }),
      startHeadroomProxy({ startupTimeoutMs: 20 }),
    ]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});
