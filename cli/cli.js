#!/usr/bin/env node

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");
const { openBrowser: openBrowserWithoutShell } = require("./src/shared/openBrowser");
const pkg = require("./package.json");
const { DEFAULT_HOST, DEFAULT_PORT, formatHelp, isLoopbackHost, parseCliArgs } = require("./src/cli/cliOptions");
const processTools = require("./src/cli/processManager");
const { findListeningPids } = processTools;
const { probeSwitchboard, probeTcp, waitForSwitchboard } = require("./src/cli/serverStatus");

let cliOptions;
try {
  cliOptions = parseCliArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error.message}\n`);
  console.error(formatHelp({ version: pkg.version }));
  process.exit(2);
}

if (cliOptions.help) {
  console.log(formatHelp({ version: pkg.version }));
  process.exit(0);
}
if (cliOptions.version) {
  console.log(pkg.version);
  process.exit(0);
}
const startsServer = ["start", "restart"].includes(cliOptions.command);

// Native spinner - no external dependency
function createSpinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let interval = null;
  let currentText = text;
  return {
    start() {
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${frames[0]} ${currentText}`);
        interval = setInterval(() => {
          process.stdout.write(`\r${frames[i++ % frames.length]} ${currentText}`);
        }, 80);
      }
      return this;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K");
      }
    },
    succeed(msg) {
      this.stop();
      console.log(`✅ ${msg}`);
    },
    fail(msg) {
      this.stop();
      console.log(`❌ ${msg}`);
    }
  };
}

const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const { ensureTrayRuntime } = require("./hooks/trayRuntime");
const { pinDataDir, getDataDir } = require("./src/shared/dataDir");

// Resolve the data directory ONCE, before anything can create cache dirs inside
// a candidate, and export it so the spawned server and the CLI's token client
// cannot disagree about where the database and cli-secret live.
pinDataDir();

// Self-heal SQLite runtime deps (sql.js + better-sqlite3) into ~/.switchboard/runtime
// so the server can resolve them via NODE_PATH. Best-effort — sql.js is required,
// better-sqlite3 is optional. Logs to stderr only on failure.
if (startsServer) {
  try { ensureSqliteRuntime({ silent: true }); } catch {}
}

// Self-heal tray runtime (systray for macOS/Linux only). Windows skipped.
if (startsServer) {
  try { ensureTrayRuntime({ silent: true }); } catch {}
}

// Configuration constants
// npm package name (switchboard-router) vs CLI bin (switchboard)
const PKG_NAME = pkg.name || "switchboard-router";
const APP_NAME =
  (pkg.bin && Object.keys(pkg.bin)[0]) || "switchboard";
const INSTALL_CMD_LATEST = `npm i -g ${PKG_NAME}@latest --prefer-online`;
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function commandFor(action = "") {
  const commandName = action ? `${APP_NAME} ${action}` : APP_NAME;
  return `${commandName}${port === DEFAULT_PORT ? "" : ` --port ${port}`}`;
}

// C1: bind loopback by default — LAN exposure is an explicit opt-in via --host 0.0.0.0
const ALL_INTERFACES = "0.0.0.0";

function isNetworkExposed() {
  return !isLoopbackHost(host);
}

function getProbeHost() {
  if (host === ALL_INTERFACES) return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function needsOwnedTcpProbe() {
  return isNetworkExposed() && host !== ALL_INTERFACES && host !== "::";
}

function hasOwnedServerListener() {
  return findListeningPids(port).some((pid) => processTools.processMatchesRecordedPath(pid, serverPath));
}

// First non-internal IPv4 — the address remote peers actually reach when bound to 0.0.0.0.
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

// Local URL stays "localhost" for loopback binds.
function getDisplayHost() {
  if ([DEFAULT_HOST, "localhost", "::1", ALL_INTERFACES, "::"].includes(host)) return "localhost";
  return host;
}
const command = cliOptions.command;
let port = cliOptions.port;
let host = cliOptions.host;
const noBrowser = cliOptions.noBrowser;
const skipUpdate = cliOptions.skipUpdate;
const showLog = cliOptions.showLog;
let trayMode = cliOptions.trayMode;

if (noBrowser) {
  console.warn("Note: --no-browser is retained for compatibility; Switchboard only opens a browser when you explicitly select Web UI.");
}

// A detached or piped CLI cannot answer the interactive menu. Keep it in the
// long-lived tray lifecycle even when it was launched without lifecycle flags.
if (startsServer && (!process.stdin.isTTY || !process.stdout.isTTY) && !trayMode) {
  trayMode = true;
  process.env.TRAY_MODE = "1";
}

// Always use Node.js runtime with absolute path
const RUNTIME = process.execPath;

// Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

// PID/runtime state lives in the SAME directory the server writes to. Hardcoding
// `.switchboard` here would look for `.mitm.pid` in the wrong place under legacy
// adoption or an explicit DATA_DIR, leaving a privileged MITM process alive on
// port 443. pinDataDir() ran at startup, so this is the resolved value.
const getAppDataDir = getDataDir;
const getProcessStateFile = () => path.join(getAppDataDir(), "runtime", "owned-processes.json");

function readOwnedProcessState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getProcessStateFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeOwnedProcessState(serverPid) {
  try {
    const file = getProcessStateFile();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const state = JSON.stringify({
      cliPid: process.pid,
      cliPath: __filename,
      serverPid,
      serverPath,
      port,
      host,
      instanceId: INSTANCE_ID,
      writtenAt: Date.now(),
    });
    fs.writeFileSync(tmp, state, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* best effort */ }
}

function clearOwnedProcessState() {
  try {
    const state = readOwnedProcessState();
    if (Number(state.cliPid) === process.pid && state.instanceId === INSTANCE_ID) fs.unlinkSync(getProcessStateFile());
  } catch { /* best effort */ }
}

function clearRecordedProcessState(state) {
  try {
    const current = readOwnedProcessState();
    const sameGeneration = current.instanceId
      ? current.instanceId === state.instanceId
      : Number(current.cliPid) === Number(state.cliPid)
        && Number(current.serverPid) === Number(state.serverPid)
        && Number(current.writtenAt) === Number(state.writtenAt);
    if (sameGeneration) fs.unlinkSync(getProcessStateFile());
  } catch { /* best effort */ }
}

function readOwnedAppPids() {
  const state = readOwnedProcessState();
  return [
    [state.serverPid, state.serverPath],
    [state.cliPid, state.cliPath],
  ]
    .filter(([, expectedPath]) => typeof expectedPath === "string" && expectedPath.length > 0)
    .map(([pid, expectedPath]) => [Number(pid), expectedPath])
    .filter(([pid, expectedPath]) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && processTools.processMatchesRecordedPath(pid, expectedPath))
    .map(([pid]) => pid);
}

// Kill PID from file (best-effort, removes file after)
function killByPidFile(pidFile, expectedProcessNames = []) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    const commandLine = processTools.getProcessCommand(pid).toLowerCase();
    if (!commandLine || !expectedProcessNames.some((name) => commandLine.includes(name.toLowerCase()))) {
      console.warn(`[switchboard] refusing to signal unverifiable PID ${pid} from ${pidFile}`);
      return;
    }
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { }
    if (!processTools.isPidAlive(pid)) {
      try { fs.unlinkSync(pidFile); } catch { }
    }
  } catch { }
}

// Kill tunnel processes (cloudflared/tailscale) by their PID files
function killTunnelByPidFile() {
  const tunnelDir = path.join(getAppDataDir(), "tunnel");
  killByPidFile(path.join(tunnelDir, "cloudflared.pid"), ["cloudflared"]);
  killByPidFile(path.join(tunnelDir, "tailscale.pid"), ["tailscale"]);
}

// Kill only processes previously recorded by this launcher.
async function killAllAppProcesses(appPort) {
  killProxyByPidFile();
  killTunnelByPidFile();
  const state = readOwnedProcessState();
  const recoverableServerPids = findListeningPids(appPort)
    .filter((pid) => processTools.processMatchesRecordedPath(pid, serverPath));
  const uniquePids = [...new Set([...readOwnedAppPids(), ...recoverableServerPids].map(Number))];
  const serverPids = new Set([Number(state.serverPid), ...recoverableServerPids]);
  const results = await Promise.allSettled(uniquePids.map((pid) => processTools.terminatePid(pid, {
    timeoutMs: 2500,
    processGroup: serverPids.has(pid),
  })));
  const allStopped = results.every((result) => result.status === "fulfilled" && result.value === true);
  if (allStopped) clearRecordedProcessState(state);
  return allStopped;
}

// Sleep helper using SharedArrayBuffer wait (sync, no busy-loop)
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// Wait until process dies or timeout reached
function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    sleepSync(100);
  }
  return false;
}

// Kill MIT server by PID file (runs privileged, needs special handling)
// Sends SIGTERM first so MIT can clean up host entries before dying.
function killProxyByPidFile() {
  try {
    const pidFile = path.join(getAppDataDir(), "mitm", ".mitm.pid");
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    const commandLine = processTools.getProcessCommand(pid).toLowerCase();
    if (!commandLine || !commandLine.includes("mitm") || !commandLine.includes("server")) {
      console.warn(`[switchboard] refusing to signal unverifiable MITM PID ${pid}`);
      return;
    }

    if (process.platform === "win32") {
      // Graceful first (lets server cleanup hosts), then force
      try { execSync(`taskkill /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 2000 }); } catch { }
      if (!waitForExit(pid, 1500)) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { }
      }
      // Last-resort: PowerShell Stop-Process (sometimes succeeds where taskkill fails on admin processes)
      if (!waitForExit(pid, 500)) {
        try { execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { }
      }
    } else {
      // SIGTERM via cached sudo token first
      try { execSync(`sudo -n kill -TERM ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 }); }
      catch { try { process.kill(pid, "SIGTERM"); } catch { } }
      if (!waitForExit(pid, 1500)) {
        try { execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 2000 }); }
        catch { try { process.kill(pid, "SIGKILL"); } catch { } }
      }
    }
    if (!processTools.isPidAlive(pid)) {
      try { fs.unlinkSync(pidFile); } catch { }
    }
  } catch { }
}

// Never kill an arbitrary listener that happens to share the app port. The
// launcher may only signal PIDs recorded in its ownership state file.
async function killProcessOnPort(port) {
  const listeningPids = findListeningPids(port);
  const ownedPids = new Set([
    ...readOwnedAppPids(),
    ...listeningPids.filter((pid) => processTools.processMatchesRecordedPath(pid, serverPath)),
  ]);
  const pids = listeningPids.filter((pid) => ownedPids.has(pid));
  const results = await Promise.allSettled(pids.map((pid) => processTools.terminatePid(pid, { timeoutMs: 1000 })));
  return results.every((result) => result.status === "fulfilled" && result.value === true);
}


// Detect if running in restricted environment (Codespaces, Docker)
function isRestrictedEnvironment() {
  // Check for Codespaces
  if (process.env.CODESPACES === "true" || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return "GitHub Codespaces";
  }

  // Check for Docker
  if (fs.existsSync("/.dockerenv") || (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"))) {
    return "Docker";
  }

  return null;
}

// Check if new version available, return latest version or null
function checkForUpdate() {
  return new Promise((resolve) => {
    if (skipUpdate) {
      resolve(null);
      return;
    }

    const spinner = createSpinner("Checking for updates...").start();
    let resolved = false;

    const safetyTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        spinner.stop();
        resolve(null);
      }
    }, 8000);

    const done = (version) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimeout);
      spinner.stop();
      resolve(version);
    };

    // Poll our npm package (not bare "switchboard" — that name is taken on npm).
    // Default matches cli/package.json "name" and UPDATER_CONFIG.npmPackageName.
    const updatePackage =
      process.env.SWITCHBOARD_NPM_PACKAGE ||
      process.env.NPM_UPDATE_PACKAGE ||
      PKG_NAME;
    const req = https.get(`https://registry.npmjs.org/${updatePackage}/latest`, { timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            done(null);
            return;
          }
          const latest = JSON.parse(data);
          const ver = latest.version;
          // Reject name collisions: require a router/gateway-looking description
          const desc = String(latest.description || "").toLowerCase();
          const looksOurs = /switchboard|routing|router|gateway|model/.test(desc);
          if (ver && looksOurs && compareVersions(ver, pkg.version) > 0) {
            done(ver);
          } else {
            done(null);
          }
        } catch (e) {
          done(null);
        }
      });
    });

    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
  });
}

// Open browser
function openBrowser(url) {
  openBrowserWithoutShell(url, {
    onError: () => {
      console.log(`Open browser manually: ${url}`);
    },
  });
}

// Find standalone server (bundled in bin/app for published package).
// Prefer custom-server.js (injects real socket IP) when present.
const standaloneDir = path.join(__dirname, "app");
const customServerPath = path.join(standaloneDir, "custom-server.js");
const serverPath = fs.existsSync(customServerPath)
  ? customServerPath
  : path.join(standaloneDir, "server.js");

if (startsServer && !fs.existsSync(serverPath)) {
  console.error("Error: Standalone build not found.");
  console.error("Please run 'npm run build:cli' first.");
  process.exit(1);
}

async function probeRunningSwitchboard() {
  const serverInfo = await probeSwitchboard(port, 1000, getProbeHost());
  if (serverInfo) return serverInfo;
  if (needsOwnedTcpProbe() && hasOwnedServerListener() && await probeTcp(port, 1000, getProbeHost())) {
    return { name: "switchboard-app", version: null, startedAt: null, tcpOnly: true };
  }
  return null;
}

async function showStatus() {
  const listeners = findListeningPids(port);
  const serverInfo = await probeSwitchboard(port, 1000, getProbeHost());
  const state = readOwnedProcessState();
  const stateApplies = Number(state.port) === port;
  const recordedPids = stateApplies ? new Set(readOwnedAppPids()) : new Set();
  const owned = listeners.filter((pid) =>
    recordedPids.has(pid) || processTools.processMatchesRecordedPath(pid, serverPath)
  );
  const tcpVerified = !serverInfo && needsOwnedTcpProbe() && owned.length > 0
    ? await probeTcp(port, 1000, getProbeHost())
    : false;
  const verifiedServer = (!!serverInfo && (!serverInfo.legacyHealth || owned.length > 0)) || tcpVerified;
  const result = {
    running: verifiedServer,
    port,
    url: `http://localhost:${port}`,
    listenerPids: listeners,
    ownedPids: owned,
    cliPid: stateApplies && recordedPids.has(Number(state.cliPid)) ? Number(state.cliPid) : null,
    serverPid: verifiedServer ? (owned[0] || listeners[0] || null) : null,
    serverVersion: serverInfo?.version || null,
    cliVersion: pkg.version,
    startedAt: serverInfo?.startedAt || null,
    conflict: listeners.length > 0 && !verifiedServer,
  };

  if (cliOptions.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.running) {
    console.log(`Switchboard is running at ${result.url}`);
    console.log(`Server: v${result.serverVersion || "unknown"} (PID: ${result.serverPid || "unknown"})`);
    console.log(`CLI:    v${result.cliVersion}`);
    console.log(`Managed: ${owned.length ? "yes" : "no (this CLI will not signal an unverified process)"}`);
    if (result.startedAt) console.log(`Started: ${result.startedAt}`);
    if (owned.length) {
      console.log(`Stop:   ${commandFor("stop")}`);
      console.log(`Restart:${commandFor("restart")}`);
    }
  } else if (result.conflict) {
    console.error(`Switchboard is stopped, but port ${port} is used by another process (PID: ${listeners.join(", ")}).`);
  } else {
    console.log(`Switchboard is not running on port ${port}.`);
    console.log(`Start: ${commandFor()}`);
  }
  return result;
}

async function stopExistingInstance({ quiet = false } = {}) {
  const before = quiet ? null : await probeRunningSwitchboard();
  if (!quiet) console.log(before ? `Stopping Switchboard on port ${port}...` : `Checking for an owned Switchboard instance on port ${port}...`);
  await killAllAppProcesses(port);
  await killProcessOnPort(port);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await probeRunningSwitchboard();
  const survivors = readOwnedAppPids();
  if (after || survivors.length > 0) {
    const listeners = findListeningPids(port);
    console.error(`Could not safely stop Switchboard on port ${port}${listeners.length ? ` (PID: ${listeners.join(", ")})` : ""}.`);
    console.error(`Run "${commandFor("status")}" for details.`);
    return false;
  }
  clearRecordedProcessState(readOwnedProcessState());
  if (!quiet) console.log(before ? "Switchboard stopped gracefully." : "No running owned instance found.");
  return true;
}

async function run() {
  if (["status", "stop", "restart"].includes(command)) {
    const recorded = readOwnedProcessState();
    if (!cliOptions.portProvided && Number.isInteger(Number(recorded.port)) && Number(recorded.port) > 0 && Number(recorded.port) <= 65535) {
      port = Number(recorded.port);
    }
    if (!cliOptions.hostProvided && typeof recorded.host === "string" && recorded.host) host = recorded.host;
  }
  if (command === "status") {
    const status = await showStatus();
    return status.running ? 0 : status.conflict ? 1 : 3;
  }
  const releaseLock = await processTools.acquireLifecycleLock(getAppDataDir(), { instanceId: INSTANCE_ID });
  try {
    if (command === "stop") {
      const stopped = await stopExistingInstance();
      return stopped ? 0 : 1;
    }

    if (command === "restart") console.log(`Restarting Switchboard on port ${port}...`);
    const stopped = await stopExistingInstance({ quiet: command === "start" });
    if (!stopped) return 1;

    const remaining = findListeningPids(port);
    if (remaining.length > 0) {
      const existing = await probeSwitchboard(port, 1000, getProbeHost());
      const recoverable = remaining.some((pid) => processTools.processMatchesRecordedPath(pid, serverPath));
      if (existing && (!existing.legacyHealth || recoverable)) {
        console.log(`Switchboard is already running at http://localhost:${port} (v${existing.version || "unknown"}).`);
        console.log(`Use "${commandFor("restart")}" to replace it.`);
        return 0;
      }
      console.error(`Port ${port} is already in use by another process (PID: ${remaining.join(", ")}).`);
      console.error(`Choose another port with --port or stop that process first.`);
      return 1;
    }

    const latestVersion = await checkForUpdate();
    startServer(latestVersion);
    return null;
  } finally {
    releaseLock();
  }
}

run()
  .then((exitCode) => {
    if (Number.isInteger(exitCode)) process.exit(exitCode);
  })
  .catch((error) => {
    console.error(`Failed to start Switchboard: ${error.message}`);
    process.exit(1);
  });

// Show interface selection menu
async function showInterfaceMenu(latestVersion, { trayAvailable = true } = {}) {
  const { selectMenu } = require("./src/cli/utils/input");
  const { clearScreen } = require("./src/cli/utils/display");
  const { getEndpoint } = require("./src/cli/utils/endpoint");
  const { buildInterfaceMenuItems } = require("./src/cli/interfaceMenu");

  clearScreen();

  const displayHost = getDisplayHost();

  // Detect tunnel/local mode for server URL display
  let serverUrl;
  try {
    const { endpoint, tunnelEnabled } = await getEndpoint(port);
    serverUrl = tunnelEnabled ? endpoint.replace(/\/v1$/, "") : `http://${displayHost}:${port}`;
  } catch (e) {
    serverUrl = `http://${displayHost}:${port}`;
  }

  const subtitle = `🚀 Server: \x1b[32m${serverUrl}\x1b[0m`;

  const menuItems = buildInterfaceMenuItems({
    latestVersion,
    currentVersion: pkg.version,
    trayAvailable,
  });

  const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle);
  return menuItems[selected]?.action || "exit";
}

const MAX_RESTARTS = 2;
const RESTART_RESET_MS = 30000; // Reset counter if alive > 30s

function startServer(latestVersion) {
  const displayHost = getDisplayHost();
  const url = `http://${displayHost}:${port}/dashboard`;
  // Surface real network exposure for wildcard and specific non-loopback binds.
  if (isNetworkExposed()) {
    const reachableHost = host === ALL_INTERFACES || host === "::" ? getLanIp() : host;
    if (reachableHost) console.log(`\x1b[33m⚠ Network-exposed: reachable at http://${reachableHost}:${port} (bound ${host}). Use --host 127.0.0.1 for local-only. Non-loopback /v1 requires an API key by default.\x1b[0m`);
  }

  let restartCount = 0;
  let serverStartTime = Date.now();

  const CRASH_LOG_LINES = 50;
  let crashLog = [];

  function spawnServer() {
    serverStartTime = Date.now();
    crashLog = [];
    const child = spawn(RUNTIME, ["--max-old-space-size=6144", serverPath], {
      cwd: standaloneDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      env: {
        ...buildEnvWithRuntime(process.env),
        PORT: port.toString(),
        HOSTNAME: host
      }
    });
    if (child.pid) writeOwnedProcessState(child.pid);
    const captureOutput = (stream, destination) => {
      if (!stream) return;
      stream.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        crashLog.push(...lines);
        if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES);
        if (showLog && destination?.writable) destination.write(data);
      });
    };
    captureOutput(child.stdout, process.stdout);
    captureOutput(child.stderr, process.stderr);
    return child;
  }

  let server = spawnServer();

  // One bounded, idempotent shutdown path owns every exit trigger.
  let isCleaningUp = false;
  let isShuttingDown = false;
  let shutdownPromise = null;
  let restartTimer = null;

  async function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      let trayCleanup = Promise.resolve();
      try {
        const { killTray } = require("./src/cli/tray/tray");
        trayCleanup = killTray();
      } catch (e) { }
      killProxyByPidFile();
      killTunnelByPidFile();
      const serverCleanup = server?.pid
        ? processTools.terminatePid(server.pid, { timeoutMs: 2500, processGroup: true })
        : Promise.resolve(true);
      const [, serverResult] = await Promise.allSettled([trayCleanup, serverCleanup]);
      if (serverResult.status === "fulfilled" && serverResult.value === true) clearOwnedProcessState();
    } catch (e) { }
  }

  function shutdown(exitCode = 0, message = "") {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (message) console.log(message);
    shutdownPromise = cleanup().finally(() => process.exit(exitCode));
    return shutdownPromise;
  }

  process.on("uncaughtException", (err) => {
    if (isShuttingDown) return;
    console.error("Error:", err.message);
    void shutdown(1);
  });

  process.on("SIGINT", () => { void shutdown(0, "\nStopping Switchboard gracefully..."); });
  process.on("SIGTERM", () => { void shutdown(0); });
  process.on("SIGHUP", () => { void shutdown(0); });

  const initTrayIcon = async () => {
    try {
      const { initTray } = require("./src/cli/tray/tray");
      const tray = initTray({
        port,
        host,
        onQuit: async () => {
          console.log("\n👋 Shutting down from tray...");
          await shutdown(0);
        },
        onOpenDashboard: () => openBrowser(url)
      });
      if (!tray) return false;
      if (typeof tray.ready === "function") {
        await Promise.race([
          tray.ready(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("tray startup timed out")), 5000)),
        ]);
      }
      return true;
    } catch (err) {
      const { describeTrayError } = require("./src/cli/tray/tray");
      console.error(`[switchboard] tray unavailable: ${describeTrayError(err)}`);
      return false;
    }
  };

  // Tray-only mode: no TUI, just tray icon
  if (trayMode) {
    // Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});

    console.log(`\n🚀 ${pkg.name} v${pkg.version}`);
    console.log(`Starting server at http://${displayHost}:${port}...`);

    void (async () => {
      const ready = await waitForSwitchboard(port, {
        hostname: getProbeHost(),
        acceptTcpFallback: needsOwnedTcpProbe() ? hasOwnedServerListener : null,
      });
      if (!ready || isShuttingDown) {
        if (!isShuttingDown) {
          console.error(`Server did not become ready on port ${port}.`);
          await shutdown(1);
        }
        return;
      }
      const trayReady = await initTrayIcon();
      if (trayReady) {
        console.log("\nSwitchboard is ready in the system tray.");
        console.log("Right-click the tray icon to open the dashboard or quit.");
      } else {
        console.warn("\nSwitchboard is running without a tray icon.");
        console.warn(`Stop it gracefully with: ${commandFor("stop")}`);
      }
      console.log(`Server: http://${displayHost}:${port}`);
      console.log(`Status: ${commandFor("status")}\n`);
    })();

    return;
  }

  // Wait for the actual management endpoint before exposing controls.
  void (async () => {
    const ready = await waitForSwitchboard(port, {
      hostname: getProbeHost(),
      acceptTcpFallback: needsOwnedTcpProbe() ? hasOwnedServerListener : null,
    });
    if (!ready || isShuttingDown) {
      if (!isShuttingDown) {
        console.error(`Server did not become ready on port ${port}.`);
        await shutdown(1);
      }
      return;
    }
    const trayReady = await initTrayIcon();
    if (!trayReady) {
      console.warn(`Tray icon unavailable. You can stop safely with Ctrl+C or "${APP_NAME} stop".`);
    }

    try {
      while (true) {
        const choice = await showInterfaceMenu(latestVersion, { trayAvailable: trayReady });

        if (choice === "update") {
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();
          console.log(`\n⬆  Update v${pkg.version} → v${latestVersion}\n`);
          console.log(`Run this after exit:\n`);
          console.log(`   \x1b[33m${INSTALL_CMD_LATEST}\x1b[0m\n`);
          await shutdown(0);
          return;
        } else if (choice === "web") {
          openBrowser(url);
          // Wait for user to come back
          const { pause } = require("./src/cli/utils/input");
          await pause("\nPress Enter to go back to menu...");
        } else if (choice === "terminal") {
          // Start Terminal UI - it will return when user selects Back
          const { startTerminalUI } = require("./src/cli/terminalUI");
          await startTerminalUI(port, { networkExposed: isNetworkExposed() });
          // Loop continues, show menu again
        } else if (choice === "hide") {
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();

          if (process.platform === "darwin") {
            // macOS: keep current process alive — spawning a detached child puts
            // it outside the login session so NSStatusItem silently fails.
            process.removeAllListeners("SIGHUP");
            process.on("SIGHUP", () => {});

            console.log(`\n⏳ Switching to tray mode... (icon already visible in menu bar)`);
            console.log(`🔔 Switchboard is running in tray (PID: ${process.pid})`);
            console.log(`   Server: http://${displayHost}:${port}`);
            console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);
            console.log(`   If the icon is unavailable: ${commandFor("stop")}\n`);

            // Tray already init'd at startup — just keep event loop alive.
            return;
          }

          // Windows/Linux: spawn detached bgProcess (systray works fine in child)
          console.log(`\n⏳ Starting background process... (tray icon will appear in ~3s)`);

          await cleanup();
          const { getLaunchArgs } = require("./src/cli/tray/autostart");
          const bgArgs = [__filename, "start", ...getLaunchArgs({ port, host })];
          const bgProcess = spawn(process.execPath, bgArgs, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env }
          });
          bgProcess.unref();

          console.log(`🔔 Switchboard is now running in background (PID: ${bgProcess.pid})`);
          console.log(`   Server: http://${displayHost}:${port}`);
          console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

          process.exit(0);
        } else if (choice === "exit") {
          await shutdown(0, "\nStopping Switchboard gracefully...");
        }
      }
    } catch (err) {
      console.error("Error:", err.message);
      await shutdown(1);
    }
  })();

  function attachServerEvents() {
    const observedServer = server;
    let terminalEventHandled = false;
    const handleTerminalEvent = (code, signal, error) => {
      if (terminalEventHandled) return;
      terminalEventHandled = true;
      if (isShuttingDown) return;
      if (error) console.error("Failed to start server:", error.message);
      if (error?.code === "EADDRINUSE" || isPortConflict()) {
        void stopForPortConflict();
        return;
      }
      if (code === 0 && !signal) {
        console.log("\nServer stopped cleanly; shutting down the launcher.");
        void shutdown(0);
        return;
      }
      tryRestart(code, signal);
    };

    observedServer.on("error", (err) => {
      handleTerminalEvent(null, null, err);
    });

    observedServer.on("close", (code, signal) => {
      handleTerminalEvent(code, signal, null);
    });
  }

  function isPortConflict() {
    return crashLog.some((line) => /EADDRINUSE|address already in use|listen .*already in use/i.test(line));
  }

  async function stopForPortConflict() {
    if (isShuttingDown) return;
    const listeners = findListeningPids(port).filter((pid) => pid !== server?.pid);
    console.error(`\nPort ${port} is already in use${listeners.length ? ` (PID: ${listeners.join(", ")})` : ""}.`);
    console.error(`Run "${commandFor("status")}" or choose a different port.`);
    await shutdown(1);
  }

  function tryRestart(code, signal) {
    if (isPortConflict()) {
      void stopForPortConflict();
      return;
    }
    const aliveMs = Date.now() - serverStartTime;
    // Reset counter if last run was stable
    if (aliveMs >= RESTART_RESET_MS) restartCount = 0;

    if (restartCount >= MAX_RESTARTS) {
      console.error(`\nServer crashed ${MAX_RESTARTS} times. Giving up without changing your settings.`);
      console.error(`Data directory: ${getAppDataDir()}`);
      console.error(`Retry with server logs: ${commandFor()} --log`);
      if (crashLog.length) {
        console.error("\n--- Server crash log ---");
        crashLog.forEach(l => console.error(l));
        console.error("--- End crash log ---\n");
      }
      void shutdown(1);
      return;
    }

    restartCount++;
    const delay = Math.min(1000 * restartCount, 10000);
    const reason = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
    console.error(`\nServer exited (${reason}). Restarting in ${delay / 1000}s... (${restartCount}/${MAX_RESTARTS})`);
    if (crashLog.length) {
      console.error("\n--- Server crash log ---");
      crashLog.forEach(l => console.error(l));
      console.error("--- End crash log ---\n");
    }

    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (isShuttingDown) return;
      server = spawnServer();
      attachServerEvents();
    }, delay);
  }

  attachServerEvents();
}
