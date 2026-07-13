import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const tray = require("../../cli/src/cli/tray/tray.js");
const autostart = require("../../cli/src/cli/tray/autostart.js");
const originalEnable = autostart.enableAutoStart;

afterEach(() => {
  autostart.enableAutoStart = originalEnable;
});

describe("tray actions", () => {
  it("does not show autostart as enabled when installation fails", () => {
    autostart.enableAutoStart = vi.fn(() => false);
    const onAutostartToggle = vi.fn();

    tray.handleClick(
      tray.MENU_INDEX.AUTOSTART,
      { port: 20128 },
      onAutostartToggle,
    );

    expect(autostart.enableAutoStart).toHaveBeenCalledOnce();
    expect(onAutostartToggle).not.toHaveBeenCalled();
  });

  it("waits for the tray process to exit before invoking application cleanup", async () => {
    const order = [];
    let finishTray;
    const trayStopped = new Promise((resolve) => { finishTray = resolve; });
    const quit = tray.handleQuit(
      () => order.push("app-cleanup"),
      async () => {
        order.push("tray-stop-started");
        await trayStopped;
        order.push("tray-stopped");
      },
    );

    await Promise.resolve();
    expect(order).toEqual(["tray-stop-started"]);
    finishTray();
    await quit;
    expect(order).toEqual(["tray-stop-started", "tray-stopped", "app-cleanup"]);
  });

  it("stops systray without allowing the library to exit the CLI process", async () => {
    const trayProcess = new EventEmitter();
    trayProcess.pid = 4242;
    trayProcess.kill = vi.fn();
    const instance = {
      _process: trayProcess,
      kill: vi.fn(async (exitNode) => {
        expect(exitNode).toBe(false);
        trayProcess.emit("exit", 0, null);
      }),
    };

    await tray.stopUnixTrayInstance(instance, {
      isAlive: () => false,
      signal: vi.fn(),
    });

    expect(instance.kill).toHaveBeenCalledOnce();
    expect(instance.kill).toHaveBeenCalledWith(false);
  });
});
