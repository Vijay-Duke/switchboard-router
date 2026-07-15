const fs = require("fs");
const path = require("path");
const { openBrowser } = require("../../shared/openBrowser");
const { isPidAlive } = require("../processManager");

let trayInstance = null;
let isWinTray = false;

function describeTrayError(error, { platform = process.platform, arch = process.arch } = {}) {
  const message = error?.message || String(error);
  const incompatibleExecutable = error?.errno === -86 || message.includes("system error -86");
  if (platform === "darwin" && arch === "arm64" && incompatibleExecutable) {
    return "the macOS tray helper is x86_64-only and Rosetta 2 is unavailable; continuing without a tray icon (Web UI and Terminal UI still work)";
  }
  return message;
}

/**
 * Get icon base64 from file — used for systray (mac/linux)
 */
function getIconBase64() {
  const isWin = process.platform === "win32";
  const iconFile = isWin ? "icon.ico" : "icon.png";
  try {
    const iconPath = path.join(__dirname, iconFile);
    if (fs.existsSync(iconPath)) {
      return fs.readFileSync(iconPath).toString("base64");
    }
  } catch (e) {}
  // Fallback: minimal green dot icon (PNG)
  return "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHpJREFUOE9jYBgFgwEwMjIy/Gdg+P8fyP4PxP8ZGBgEcBnGyMjIsICBgSEAhyH/gfgBUNN8XJoZsdkCVL8Ah+b/QPwbqvkBMvk/AwMDAzYX/GdgYAhAN+A/SICRWAMYGfFEJSMjzriEiwDR/xmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC";
}

/**
 * Check if system tray is supported on current OS
 * Supported: macOS, Windows, Linux (with GUI)
 */
function isTraySupported() {
  const platform = process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) {
    return false;
  }
  if (platform === "linux" && !process.env.DISPLAY) {
    return false;
  }
  return true;
}

/**
 * Initialize system tray with menu
 * @param {Object} options - { port, onQuit, onOpenDashboard }
 * @returns {Object|null} tray instance or null if not supported/failed
 */
function initTray(options) {
  if (!isTraySupported()) {
    return null;
  }

  // Windows uses PowerShell NotifyIcon (AV-safe), others use systray
  if (process.platform === "win32") {
    return initWindowsTray(options);
  }
  return initUnixTray(options);
}

/**
 * Build menu items array shared between platforms
 */
function buildMenuItems(port, autostartEnabled) {
  return [
    { title: `Switchboard (Port ${port})`, tooltip: "Server is running", enabled: false },
    { title: "Open Dashboard", tooltip: "Open in browser", enabled: true },
    {
      title: autostartEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start",
      tooltip: "Run on OS startup",
      enabled: true
    },
    { title: "Quit", tooltip: "Stop server and exit", enabled: true }
  ];
}

// Menu item indexes
const MENU_INDEX = { STATUS: 0, DASHBOARD: 1, AUTOSTART: 2, QUIT: 3 };

/**
 * Get current autostart state
 */
function getAutostartEnabled() {
  try {
    const { isAutoStartEnabled } = require("./autostart");
    return isAutoStartEnabled();
  } catch (e) {
    return false;
  }
}

/**
 * Handle menu item click (shared logic)
 */
function handleClick(index, options, onAutostartToggle) {
  const { onQuit, onOpenDashboard, port, host } = options;
  if (index === MENU_INDEX.DASHBOARD) {
    if (onOpenDashboard) onOpenDashboard();
    else openBrowser(`http://localhost:${port}/dashboard`);
  } else if (index === MENU_INDEX.AUTOSTART) {
    const enabled = getAutostartEnabled();
    try {
      const { enableAutoStart, disableAutoStart } = require("./autostart");
      const changed = enabled ? disableAutoStart() : enableAutoStart(undefined, { port, host });
      if (changed) onAutostartToggle(!enabled);
    } catch (e) {}
  } else if (index === MENU_INDEX.QUIT) {
    console.log("\n👋 Shutting down...");
    void handleQuit(onQuit);
  }
}

async function handleQuit(onQuit, killTrayImpl = killTray, exitImpl = process.exit) {
  try {
    await killTrayImpl();
  } catch (error) {
    process.stderr.write(`[switchboard] tray cleanup error: ${error?.message || error}\n`);
  }
  if (onQuit) await onQuit();
  else exitImpl(0);
}

/**
 * Windows tray via PowerShell NotifyIcon
 */
function initWindowsTray(options) {
  const { port } = options;
  try {
    const { initWinTray } = require("./trayWin");
    const iconPath = path.join(__dirname, "icon.ico");
    const autostartEnabled = getAutostartEnabled();
    const items = buildMenuItems(port, autostartEnabled);

    trayInstance = initWinTray({
      iconPath,
      tooltip: `Switchboard - Port ${port}`,
      items,
      onClick: (index) => {
        handleClick(index, options, (newEnabled) => {
          const newTitle = newEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start";
          trayInstance.updateItem(MENU_INDEX.AUTOSTART, newTitle, true);
        });
      }
    });

    isWinTray = true;
    return trayInstance;
  } catch (err) {
    return null;
  }
}

/**
 * macOS/Linux tray via our own switchboard-tray binary.
 *
 * Spawns the Go binary directly (no systray2 dependency).
 * Binary communicates via JSON-per-line on stdin/stdout.
 * Installed as optionalDependencies per platform (esbuild pattern).
 */
function resolveTrayBinPath() {
  try {
    const { getTrayBinPath, downloadBinaryFallback } = require("../../../hooks/trayRuntime");
    return { binPath: getTrayBinPath(), downloadBinaryFallback };
  } catch {
    return { binPath: null, downloadBinaryFallback: null };
  }
}

/**
 * Lightweight tray wrapper — spawns our binary and provides the same interface
 * that the old systray2 SysTray class exposed (.onClick, .sendAction, .ready, .kill, ._process).
 */
class SwitchboardTray {
  constructor({ menu, binPath }) {
    this._binPath = binPath;
    this._menu = menu;
    this._process = null;
    this._rl = null;
    this._onClickListeners = [];
    this._readyPromise = this._start();
  }

  async _start() {
    const { spawn } = require("child_process");
    const { createInterface } = require("readline");

    this._process = spawn(this._binPath, [], { windowsHide: true });

    this._rl = createInterface({ input: this._process.stdout });

    return new Promise((resolve, reject) => {
      this._process.on("error", reject);

      const onLine = (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready") {
            // Send menu config
            this._write(JSON.stringify(this._menu));
            resolve();
          } else if (msg.type === "clicked") {
            for (const listener of this._onClickListeners) {
              listener(msg);
            }
          }
        } catch {}
      };

      this._rl.on("line", onLine);
    });
  }

  _write(line) {
    if (this._process && this._process.stdin && !this._process.stdin.destroyed) {
      this._process.stdin.write(line.trim() + "\n");
    }
  }

  ready() {
    return this._readyPromise;
  }

  onClick(listener) {
    this._onClickListeners.push(listener);
    return this._readyPromise;
  }

  sendAction(action) {
    this._write(JSON.stringify(action));
    return this;
  }

  kill(exitNode = false) {
    if (this._process) {
      this._write(JSON.stringify({ type: "exit" }));
      setTimeout(() => {
        try { this._process.kill("SIGTERM"); } catch {}
      }, 500);
    }
    if (exitNode) process.exit(0);
  }
}

function initUnixTray(options, {
  resolveTrayBinPathImpl = resolveTrayBinPath,
  getAutostartEnabledImpl = getAutostartEnabled,
} = {}) {
  const { port } = options;
  try {
    const { binPath, downloadBinaryFallback } = resolveTrayBinPathImpl();

    if (!binPath) {
      // Try async download fallback
      if (downloadBinaryFallback) {
        downloadBinaryFallback({ silent: true }).then((downloaded) => {
          if (downloaded) {
            // Binary now available — caller can retry via interface menu
            process.stderr.write("[switchboard] tray binary downloaded; restart to enable tray icon\n");
          }
        }).catch(() => {});
      }
      return null;
    }

    // Ensure executable
    try { fs.chmodSync(binPath, 0o755); } catch {}

    const autostartEnabled = getAutostartEnabledImpl();
    const items = buildMenuItems(port, autostartEnabled);

    const menu = {
      icon: getIconBase64(),
      isTemplateIcon: false,
      title: "",
      tooltip: `Switchboard - Port ${port}`,
      items
    };

    trayInstance = new SwitchboardTray({ menu, binPath });
    isWinTray = false;

    const clickRegistration = trayInstance.onClick((action) => {
      handleClick(action.seq_id, options, (newEnabled) => {
        trayInstance.sendAction({
          type: "update-item",
          item: {
            title: newEnabled ? "✓ Auto-start Enabled" : "Enable Auto-start",
            tooltip: "Run on OS startup",
            enabled: true
          },
          seq_id: MENU_INDEX.AUTOSTART
        });
      });
    });
    if (clickRegistration && typeof clickRegistration.catch === "function") {
      clickRegistration.catch(() => {});
    }

    trayInstance.ready().catch(() => {});

    return trayInstance;
  } catch (err) {
    process.stderr.write(`[switchboard] tray init error: ${err.message}\n`);
    return null;
  }
}

/**
 * Kill tray, wait Go binary fully exit (returns Promise).
 * Critical for hide-to-tray: macOS must release NSStatusItem before bgProcess
 * spawns a new tray, otherwise the new icon silently fails to register.
 */
function killTray() {
  const instance = trayInstance;
  const wasWin = isWinTray;
  trayInstance = null;
  if (!instance) return Promise.resolve();

  if (wasWin) {
    try { return Promise.resolve(instance.kill()); } catch (e) { return Promise.resolve(); }
  }

  return stopUnixTrayInstance(instance);
}

async function stopUnixTrayInstance(instance, options = {}) {
  const proc = options.proc || (() => {
    try { return instance._process || (typeof instance.process === "function" ? instance.process() : null); }
    catch { return null; }
  })();
  const isAlive = options.isAlive || isPidAlive;
  const signal = options.signal || ((target, name) => target.kill(name));

  if (!proc || !proc.pid) {
    try { await instance.kill(false); } catch (e) {}
    return;
  }

  await new Promise((resolve) => {
    let done = false;
    const timers = [];
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      proc.removeListener("exit", finish);
      resolve();
    };

    proc.once("exit", finish);
    // SIGKILL can leave a ghost icon, so give IPC and SIGTERM time first.
    timers.push(setTimeout(() => { if (isAlive(proc.pid)) { try { signal(proc, "SIGTERM"); } catch (e) {} } }, 800));
    timers.push(setTimeout(() => { if (isAlive(proc.pid)) { try { signal(proc, "SIGKILL"); } catch (e) {} } }, 1600));
    timers.push(setTimeout(finish, 3000));
    try {
      const result = instance.kill(false);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (e) {}
  });
}

module.exports = {
  describeTrayError,
  initTray,
  initUnixTray,
  killTray,
  handleClick,
  handleQuit,
  stopUnixTrayInstance,
  MENU_INDEX,
};
