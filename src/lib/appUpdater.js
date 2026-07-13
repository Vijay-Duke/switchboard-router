import { spawn, execSync, execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { matchesRecordedProcess } from "@/lib/processIdentity";

const PROCESS_WAIT_MS = 2000;

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function processMatchesRecordedPath(pid, expectedPath) {
  if (!expectedPath) return false;
  try {
    const command = process.platform === "win32"
      ? execFileSync("powershell", ["-NonInteractive", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 3000 })
      : execFileSync("ps", ["-p", String(Number(pid)), "-o", "command="], { encoding: "utf8", timeout: 3000 });
    if (matchesRecordedProcess({ command, cwd: "", expectedPath })) return true;
    let cwd = "";
    if (process.platform === "linux") {
      try { cwd = fs.readlinkSync(`/proc/${Number(pid)}/cwd`); } catch { /* fail closed below */ }
    } else if (process.platform !== "win32") {
      try {
        const output = execFileSync("lsof", ["-a", "-p", String(Number(pid)), "-d", "cwd", "-Fn"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        });
        const line = output.split(/\r?\n/).find((entry) => entry.startsWith("n"));
        cwd = line ? line.slice(1) : "";
      } catch { /* fail closed below */ }
    }
    return matchesRecordedProcess({ command, cwd, expectedPath });
  } catch {
    // PID reuse is worse than leaving an old process behind: fail closed when
    // the recorded command identity cannot be checked.
    return false;
  }
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
      getDataDir(),
      "mitm",
      ".mitm.pid"
    );
    if (!fs.existsSync(mitmPidFile)) return;
    const pid = parseInt(fs.readFileSync(mitmPidFile, "utf8").trim(), 10);
    if (!pid) return;
    const command = process.platform === "win32"
      ? execFileSync("powershell", ["-NonInteractive", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 3000 })
      : execFileSync("ps", ["-p", String(Number(pid)), "-o", "command="], { encoding: "utf8", timeout: 3000 });
    const normalized = String(command).toLowerCase();
    if (!normalized.includes("mitm") || !normalized.includes("server")) return;

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
    return [
      [state.cliPid, state.cliPath],
      [state.serverPid, state.serverPath],
    ]
      .filter(([, expectedPath]) => typeof expectedPath === "string" && expectedPath.length > 0)
      .map(([pid, expectedPath]) => [Number(pid), expectedPath])
      .filter(([pid, expectedPath]) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && processMatchesRecordedPath(pid, expectedPath))
      .map(([pid]) => pid);
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

function resolveRelaunchSettings() {
  const configuredPort = Number.parseInt(process.env.PORT || "", 10);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : UPDATER_CONFIG.appPort;
  const host = process.env.HOST || process.env.HOSTNAME || "127.0.0.1";
  return { port, host };
}

// Spawn detached headless updater (Node process) then exit current server
async function waitForUpdaterReady(file, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // The file is a tiny one-line token; synchronous reads keep polling
      // deterministic across shutdown and fake-timer environments.
      if (fs.readFileSync(file, "utf8").trim() === token) return true;
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function spawnUpdaterAndExit(packageName = UPDATER_CONFIG.npmPackageName) {
  const updaterPath = ensureRuntimeUpdater(resolveBundledUpdaterPath());
  const isTray = process.env.TRAY_MODE === "1";
  const relaunch = resolveRelaunchCommand();
  const relaunchSettings = resolveRelaunchSettings();
  // Relaunch matching original settings: preserve custom bind/port and mode.
  const relaunchArgs = [
    ...relaunch.args,
    "--port", String(relaunchSettings.port),
    "--host", relaunchSettings.host,
    ...(isTray ? ["--tray"] : []),
    "--skip-update",
  ];

  const readyToken = crypto.randomBytes(24).toString("hex");
  const readyFile = path.join(getDataDir(), "update", `ready-${process.pid}-${Date.now()}-${readyToken.slice(0, 12)}.token`);

  let updater;
  try {
    updater = spawn(process.execPath, [updaterPath], {
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
        UPDATER_STARTUP_TIMEOUT_MS: String(UPDATER_CONFIG.statusStartupTimeoutMs),
        UPDATER_READY_FILE: readyFile,
        UPDATER_READY_TOKEN: readyToken,
        UPDATER_APP_PORT: String(relaunchSettings.port),
        UPDATER_RELAUNCH: "1",
        UPDATER_RELAUNCH_CMD: relaunch.cmd,
        UPDATER_RELAUNCH_ARGS: JSON.stringify(relaunchArgs),
      },
    });
  } catch (error) {
    return { started: false, error: `Could not start updater: ${error.message}` };
  }
  let updaterFailed = false;
  const updaterFailure = new Promise((resolve) => {
    updater.on("error", () => {
      updaterFailed = true;
      resolve(false);
    });
  });
  updater.unref();

  const ready = await Promise.race([
    waitForUpdaterReady(readyFile, readyToken, UPDATER_CONFIG.statusStartupTimeoutMs + 1000),
    updaterFailure,
  ]);
  try { fs.unlinkSync(readyFile); } catch { /* updater may already have exited */ }
  if (!ready) {
    try { updater.kill(); } catch { /* already stopped */ }
    return {
      started: false,
      error: updaterFailed
        ? "Updater process failed before readiness."
        : "Updater did not become ready; Switchboard is still running.",
    };
  }

  setTimeout(() => {
    killAppProcesses()
      .catch(() => {})
      .finally(() => process.exit(0));
  }, UPDATER_CONFIG.exitDelayMs);
  return { started: true };
}
