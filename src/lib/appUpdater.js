import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { UPDATER_CONFIG } from "@/shared/constants/config";

const PROCESS_WAIT_MS = 2000;

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function terminateOwnedPid(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 1 || numericPid === process.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /T /PID ${numericPid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } else {
      process.kill(numericPid, "SIGTERM");
    }
  } catch { /* already dead or inaccessible */ }
  const deadline = Date.now() + PROCESS_WAIT_MS;
  while (isPidAlive(numericPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!isPidAlive(numericPid)) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${numericPid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } else {
      process.kill(numericPid, "SIGKILL");
    }
  } catch { /* best effort */ }
}

// Kill MITM server by PID file (MITM may run as admin/sudo)
function killMitmByPidFile() {
  try {
    const mitmPidFile = path.join(
      process.platform === "win32"
        ? path.join(process.env.APPDATA || "", "switchboard")
        : path.join(os.homedir(), ".switchboard"),
      "mitm",
      ".mitm.pid"
    );
    if (!fs.existsSync(mitmPidFile)) return;
    const pid = parseInt(fs.readFileSync(mitmPidFile, "utf8").trim(), 10);
    if (!pid) return;

    if (process.platform === "win32") {
      try { execSync(`taskkill /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch {
        try { execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { /* best effort */ }
      }
    } else {
      try {
        execSync(`sudo -n kill -TERM ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
      } catch {
        try { process.kill(pid, "SIGTERM"); } catch { /* best effort */ }
      }
    }
    try { fs.unlinkSync(mitmPidFile); } catch { /* best effort */ }
  } catch { /* best effort */ }
}

// Collect only PIDs recorded by the CLI launcher. Process-name substring
// matching can terminate unrelated Next.js apps and developer tools.
function collectAppPids() {
  try {
    const stateFile = path.join(getDataDir(), "runtime", "owned-processes.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return [state.cliPid, state.serverPid]
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  } catch { return []; }
}

// Copy updater.js into DATA_DIR so npm -g can overwrite node_modules safely
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "switchboard");
  }
  return path.join(os.homedir(), ".switchboard");
}

function resolveBundledUpdaterPath() {
  if (process.env.UPDATER_SCRIPT_PATH && fs.existsSync(process.env.UPDATER_SCRIPT_PATH)) {
    return process.env.UPDATER_SCRIPT_PATH;
  }
  // Production standalone: cwd is binAppDir (see bin/cli.js)
  // Dev: cwd is app/
  const fromCwd = path.join(process.cwd(), "src", "lib", "updater", "updater.js");
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromParent = path.join(process.cwd(), "..", "src", "lib", "updater", "updater.js");
  if (fs.existsSync(fromParent)) return fromParent;
  return fromCwd;
}

function ensureRuntimeUpdater(bundledPath) {
  try {
    if (!bundledPath || !fs.existsSync(bundledPath)) return bundledPath;
    const runtimeDir = path.join(getDataDir(), "runtime", "updater");
    const runtimePath = path.join(runtimeDir, "updater.js");
    if (fs.existsSync(runtimePath)) {
      try {
        if (fs.statSync(bundledPath).size === fs.statSync(runtimePath).size) return runtimePath;
      } catch { /* recopy */ }
    }
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(bundledPath, runtimePath);
    return runtimePath;
  } catch {
    return bundledPath;
  }
}

// Kill all app-related processes to release file locks (esp. on Windows)
export async function killAppProcesses() {
  killMitmByPidFile();
  const pids = collectAppPids();
  await Promise.all([...new Set(pids)].map(terminateOwnedPid));
}

// Resolve npx/switchboard binary to relaunch after update (cross-platform)
function resolveRelaunchCommand() {
  const isWin = process.platform === "win32";
  // Prefer `npx <published-cli>` — works regardless of global bin path after npm i -g
  const npx = isWin ? "npx.cmd" : "npx";
  return { cmd: npx, args: [UPDATER_CONFIG.npmPackageName] };
}

// Spawn detached headless updater (Node process) then exit current server
export function spawnUpdaterAndExit(packageName = UPDATER_CONFIG.npmPackageName) {
  const updaterPath = ensureRuntimeUpdater(resolveBundledUpdaterPath());
  const isTray = process.env.TRAY_MODE === "1";
  const relaunch = resolveRelaunchCommand();
  // Relaunch matching original env: tray stays tray, foreground stays foreground
  const relaunchArgs = isTray
    ? [...relaunch.args, "--tray", "--skip-update"]
    : [...relaunch.args, "--skip-update"];

  spawn(process.execPath, [updaterPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      UPDATER_PKG_NAME: packageName,
      UPDATER_PORT: String(UPDATER_CONFIG.statusPort),
      UPDATER_TAIL_LINES: String(UPDATER_CONFIG.statusLogTailLines),
      UPDATER_RETRIES: String(UPDATER_CONFIG.installRetries),
      UPDATER_RETRY_DELAY_MS: String(UPDATER_CONFIG.installRetryDelayMs),
      UPDATER_LINGER_MS: String(UPDATER_CONFIG.lingerAfterDoneMs),
      UPDATER_WAIT_MIN_MS: String(UPDATER_CONFIG.waitForExitMinMs),
      UPDATER_WAIT_MAX_MS: String(UPDATER_CONFIG.waitForExitMaxMs),
      UPDATER_WAIT_CHECK_MS: String(UPDATER_CONFIG.waitForExitCheckMs),
      UPDATER_APP_PORT: String(UPDATER_CONFIG.appPort),
      UPDATER_RELAUNCH: "1",
      UPDATER_RELAUNCH_CMD: relaunch.cmd,
      UPDATER_RELAUNCH_ARGS: JSON.stringify(relaunchArgs),
    },
  }).unref();

  setTimeout(() => process.exit(0), UPDATER_CONFIG.exitDelayMs);
}
