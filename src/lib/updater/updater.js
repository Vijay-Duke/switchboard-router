// Standalone detached updater process.
// Spawns `npm i -g <pkg>@latest`, exposes progress via tiny HTTP server.
// Survives after parent Next server exits (detached + unref by spawner).

const { execFile, spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const packageName = process.env.UPDATER_PKG_NAME || "switchboard-router";
const port = parseInt(process.env.UPDATER_PORT || "20129", 10);
const tailLines = parseInt(process.env.UPDATER_TAIL_LINES || "8", 10);
const maxRetries = parseInt(process.env.UPDATER_RETRIES || "3", 10);
const retryDelayMs = parseInt(process.env.UPDATER_RETRY_DELAY_MS || "5000", 10);
const lingerMs = parseInt(process.env.UPDATER_LINGER_MS || "30000", 10);
const waitMinMs = parseInt(process.env.UPDATER_WAIT_MIN_MS || "3000", 10);
const waitMaxMs = parseInt(process.env.UPDATER_WAIT_MAX_MS || "15000", 10);
const waitCheckMs = parseInt(process.env.UPDATER_WAIT_CHECK_MS || "500", 10);
const statusStartupTimeoutMs = parseInt(process.env.UPDATER_STARTUP_TIMEOUT_MS || "2000", 10);
const appPort = parseInt(process.env.UPDATER_APP_PORT || "20128", 10);
const readyFile = process.env.UPDATER_READY_FILE || "";
const readyToken = process.env.UPDATER_READY_TOKEN || "";
const allowedStatusOrigins = new Set([
  `http://127.0.0.1:${appPort}`,
  `http://localhost:${appPort}`,
  `http://[::1]:${appPort}`,
]);

// Data directory (match mitm/paths.js logic)
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "switchboard");
  }
  return path.join(os.homedir(), ".switchboard");
}
const updateDir = path.join(getDataDir(), "update");
try { fs.mkdirSync(updateDir, { recursive: true }); } catch { /* best effort */ }
const statusFile = path.join(updateDir, "status.json");
const logFile = path.join(updateDir, "install.log");

const state = {
  phase: "starting",
  packageName,
  startedAt: Date.now(),
  finishedAt: null,
  attempt: 0,
  maxRetries,
  done: false,
  success: false,
  exitCode: null,
  error: null,
  logTail: [],
};

function pushLog(line) {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed) return;
  state.logTail.push(trimmed);
  if (state.logTail.length > tailLines) state.logTail = state.logTail.slice(-tailLines);
  try { fs.appendFileSync(logFile, `${trimmed}\n`); } catch { /* best effort */ }
}

function persistStatus() {
  try { fs.writeFileSync(statusFile, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

function setPhase(phase) {
  state.phase = phase;
  persistStatus();
}

function publishReady() {
  if (!readyFile || !readyToken) return;
  const tmp = `${readyFile}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  fs.writeFileSync(tmp, readyToken, { mode: 0o600 });
  fs.renameSync(tmp, readyFile);
}

// HTTP server exposing status (browser polls this while Next server is dead)
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedStatusOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/update/status" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

let statusServerReady = false;
let finalized = false;
let statusServerFailed = false;
let statusServerStartupTimer = null;

function failStatusServer(error) {
  if (statusServerReady || statusServerFailed) return;
  statusServerFailed = true;
  if (statusServerStartupTimer) clearTimeout(statusServerStartupTimer);

  state.done = true;
  state.success = false;
  state.error = `status server error: ${error.message}`;
  state.finishedAt = Date.now();
  pushLog(`[updater] ${state.error}; exiting without running the installer`);
  setPhase("error");

  // Do not wait on a server that never bound. This is normally EADDRINUSE
  // when another updater already owns the fixed status port.
  try { server.close(); } catch { /* best effort */ }
  setTimeout(() => process.exit(1), Math.min(Math.max(lingerMs, 0), 1000));
}

server.on("error", (e) => {
  if (!statusServerReady) {
    failStatusServer(e);
    return;
  }
  state.error = `status server error: ${e.message}`;
  persistStatus();
});

statusServerStartupTimer = setTimeout(() => {
  failStatusServer(new Error(`status server did not bind to 127.0.0.1:${port} within ${statusStartupTimeoutMs}ms`));
}, Math.max(statusStartupTimeoutMs, 0));

try {
  server.listen(port, "127.0.0.1", () => {
    if (statusServerStartupTimer) clearTimeout(statusServerStartupTimer);
    try {
      publishReady();
    } catch (error) {
      failStatusServer(new Error(`could not publish readiness: ${error.message}`));
      return;
    }
    statusServerReady = true;
    persistStatus();
    waitForAppExit().then(runInstall).catch((error) => {
      pushLog(`[updater] wait failed: ${error.message}`);
      finalize(false, null, error.message);
    });
  });
} catch (error) {
  failStatusServer(error);
}

// Check if app port is still being listened on (= app server still alive)
function isAppPortBusy() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(appPort, "127.0.0.1");
  });
}

// Wait for app process to fully exit before running npm (avoids Windows file-lock)
async function waitForAppExit() {
  setPhase("waitingForExit");
  pushLog(`[updater] waiting for app to exit (min ${Math.round(waitMinMs / 1000)}s)...`);

  // Hard minimum delay: OS needs time to release file handles
  await sleep(waitMinMs);

  // Poll app port until free or max timeout
  const deadline = Date.now() + (waitMaxMs - waitMinMs);
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (!busy) {
      pushLog(`[updater] app port :${appPort} is free, proceeding`);
      return;
    }
    await sleep(waitCheckMs);
  }
  pushLog(`[updater] timeout waiting for app, proceeding anyway`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runInstall() {
  if (finalized) return;
  state.attempt += 1;
  setPhase("installing");
  pushLog(`[updater] attempt ${state.attempt}/${maxRetries} — npm i -g ${packageName} --prefer-online`);

  const isWin = process.platform === "win32";
  const cmd = isWin ? "npm.cmd" : "npm";
  const args = ["i", "-g", packageName, "--prefer-online"];

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWin,
  });

  child.stdout.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });
  child.stderr.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });

  let attemptSettled = false;
  const settleAttempt = (code, spawnError = null) => {
    if (attemptSettled || finalized) return;
    attemptSettled = true;
    if (spawnError) pushLog(`[updater] spawn error: ${spawnError}`);
    else pushLog(`[updater] npm exited with code ${code}`);
    if (!spawnError && code === 0) {
      finalize(true, code, null);
      return;
    }
    if (state.attempt < maxRetries) {
      pushLog(`[updater] retrying in ${Math.round(retryDelayMs / 1000)}s...`);
      setTimeout(() => { if (!finalized) runInstall(); }, retryDelayMs);
      return;
    }
    finalize(false, code, spawnError || `Install failed after ${maxRetries} attempts`);
  };

  child.on("error", (e) => {
    settleAttempt(null, e.message);
  });

  child.on("close", (code) => {
    settleAttempt(code);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const launcher = platform === "darwin"
    ? { command: "/usr/bin/open", args: [url] }
    : platform === "win32"
      ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : { command: "xdg-open", args: [url] };
  return new Promise((resolve) => {
    try {
      execFile(launcher.command, launcher.args, { windowsHide: true, timeout: 3000 }, (error) => {
        if (error) pushLog(`[updater] browser launch failed: ${error.message}`);
        resolve(!error);
      });
    } catch (error) {
      pushLog(`[updater] browser launch failed: ${error.message}`);
      resolve(false);
    }
  });
}

// Wait until app port is listening (server alive again), then open dashboard
async function waitForAppAndOpenBrowser() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (busy) {
      const dashboardUrl = `http://localhost:${appPort}/dashboard`;
      const opened = await openBrowser(dashboardUrl);
      pushLog(opened
        ? `[updater] app ready, opened dashboard`
        : `[updater] app ready; open dashboard manually: ${dashboardUrl}`);
      return;
    }
    await sleep(1000);
  }
  pushLog(`[updater] app not responding within 30s, skip browser open`);
}

function relaunchApp() {
  if (process.env.UPDATER_RELAUNCH !== "1") return;
  const cmd = process.env.UPDATER_RELAUNCH_CMD;
  if (!cmd) return;
  let args = [];
  try { args = JSON.parse(process.env.UPDATER_RELAUNCH_ARGS || "[]"); } catch { /* noop */ }
  const isWin = process.platform === "win32";
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: isWin,
      env: { ...process.env, UPDATER_RELAUNCH: "", UPDATER_RELAUNCH_CMD: "", UPDATER_RELAUNCH_ARGS: "" },
    });
    child.once("error", (error) => {
      pushLog(`[updater] relaunch failed: ${error.message}`);
    });
    child.once("spawn", () => {
      pushLog(`[updater] relaunched: ${cmd} ${args.join(" ")} (pid=${child.pid})`);
      // Wait for new app to come up, then auto-open browser so user sees the result
      waitForAppAndOpenBrowser();
    });
    child.unref();
  } catch (e) {
    pushLog(`[updater] relaunch failed: ${e.message}`);
  }
}

function finalize(success, exitCode, error) {
  if (finalized) return;
  finalized = true;
  state.done = true;
  state.success = success;
  state.exitCode = exitCode;
  state.error = error;
  state.finishedAt = Date.now();
  setPhase(success ? "done" : "error");
  // Restore service even when installation fails; the previously installed
  // package is still the safest recovery target.
  relaunchApp();
  // Linger so browser can poll final status, then exit & close the port
  setTimeout(() => {
    try { server.close(); } catch { /* ignore */ }
    process.exit(success ? 0 : 1);
  }, lingerMs);
}
