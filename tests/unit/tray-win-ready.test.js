import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const TRAY_WIN = require.resolve("../../cli/src/cli/tray/trayWin.js");
const TRAY = require.resolve("../../cli/src/cli/tray/tray.js");
const AUTOSTART = require.resolve("../../cli/src/cli/tray/autostart.js");

// Fake powershell child: never spawns anything, just an EventEmitter with
// the stdio surface trayWin.js touches.
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: vi.fn() };
  child.kill = vi.fn(() => { child.killed = true; });
  return child;
}

function initWithFake(options = {}) {
  const child = fakeChild();
  const spawnImpl = vi.fn(() => child);
  const { initWinTray } = require(TRAY_WIN);
  const tray = initWinTray(
    { iconPath: "icon.ico", tooltip: "t", items: [{ title: "Quit", enabled: true }], onClick: vi.fn(), ...options },
    { spawnImpl }
  );
  return { child, tray, spawnImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[TRAY];
});

describe("Windows tray ready() (L14)", () => {
  it("never touches the real spawn and sends the initial items", () => {
    const { child, tray, spawnImpl } = initWithFake();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][0]).toBe("powershell.exe");
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"add-item"'), "utf8");
    expect(typeof tray.ready).toBe("function");
  });

  it("resolves once tray.ps1 emits the started event", async () => {
    const { child, tray } = initWithFake();
    const ready = tray.ready(1000);
    child.stdout.write('{"type":"started"}\n');
    await expect(ready).resolves.toBe(true);
    // Already started: later calls resolve immediately.
    await expect(tray.ready(1)).resolves.toBe(true);
  });

  it("rejects when powershell exits before started", async () => {
    const { child, tray } = initWithFake();
    const ready = tray.ready(1000);
    child.emit("exit", 1);
    await expect(ready).rejects.toThrow(/exited before started/);
    await expect(tray.ready(1000)).rejects.toThrow(/exited before started/);
  });

  it("rejects on timeout when no started event arrives", async () => {
    const { tray } = initWithFake();
    await expect(tray.ready(20)).rejects.toThrow(/timed out/);
  });

  it("flows ready() through tray.js initTray on win32", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const fakeTray = { ready: vi.fn(() => Promise.resolve(true)), updateItem: vi.fn(), setTooltip: vi.fn(), kill: vi.fn() };
    const initWinTray = vi.fn(() => fakeTray);
    require.cache[TRAY_WIN] = { id: TRAY_WIN, filename: TRAY_WIN, loaded: true, exports: { initWinTray } };
    require.cache[AUTOSTART] = { id: AUTOSTART, filename: AUTOSTART, loaded: true, exports: { isAutoStartEnabled: () => false } };
    try {
      delete require.cache[TRAY];
      const { initTray } = require(TRAY);
      const tray = initTray({ port: 20128, host: "127.0.0.1", onQuit: vi.fn(), onOpenDashboard: vi.fn() });
      expect(initWinTray).toHaveBeenCalledTimes(1);
      expect(tray).toBe(fakeTray);
      await expect(tray.ready()).resolves.toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
      delete require.cache[TRAY_WIN];
      delete require.cache[AUTOSTART];
    }
  });
});
