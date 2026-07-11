#!/usr/bin/env node

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");
const { openBrowser: openBrowserWithoutShell } = require("./src/shared/openBrowser");

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

const pkg = require("./package.json");
const { ensureSqliteRuntime, buildEnvWithRuntime } = require("./hooks/sqliteRuntime");
const { ensureTrayRuntime } = require("./hooks/trayRuntime");
const { pinDataDir, getDataDir } = require("./src/shared/dataDir");
const { disableMitm } = require("./src/shared/disableMitm");
const args = process.argv.slice(2);

// Resolve the data directory ONCE, before anything can create cache dirs inside
// a candidate, and export it so the spawned server and the CLI's token client
// cannot disagree about where the database and cli-secret live.
pinDataDir();

// Self-heal SQLite runtime deps (sql.js + better-sqlite3) into ~/.switchboard/runtime
// so the server can resolve them via NODE_PATH. Best-effort — sql.js is required,
// better-sqlite3 is optional. Logs to stderr only on failure.
try { ensureSqliteRuntime({ silent: true }); } catch {}

// Self-heal tray runtime (systray for macOS/Linux only). Windows skipped.
try { ensureTrayRuntime({ silent: true }); } catch {}

// Configuration constants
// npm package name (switchboard-router) vs CLI bin (switchboard)
const PKG_NAME = pkg.name || "switchboard-router";
const APP_NAME =
  (pkg.bin && Object.keys(pkg.bin)[0]) || "switchboard";
const INSTALL_CMD_LATEST = `npm i -g ${PKG_NAME}@latest --prefer-online`;

const DEFAULT_PORT = 20128;
// C1: bind loopback by default — LAN exposure is an explicit opt-in via --host 0.0.0.0
const DEFAULT_HOST = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

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
  if (host === DEFAULT_HOST || host === "localhost" || host === "::1") return "localhost";
  return host;
}
const MAX_PORT_ATTEMPTS = 10;
// Parse arguments
let port = DEFAULT_PORT;
let host = DEFAULT_HOST;
let noBrowser = false;
let skipUpdate = false;
let showLog = false;
let trayMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") {
    port = parseInt(args[i + 1], 10) || DEFAULT_PORT;
    i++;
  } else if (args[i] === "--host" || args[i] === "-H") {
    host = args[i + 1] || DEFAULT_HOST;
    i++;
  } else if (args[i] === "--no-browser" || args[i] === "-n") {
    noBrowser = true;
  } else if (args[i] === "--log" || args[i] === "-l") {
    showLog = true;
  } else if (args[i] === "--skip-update") {
    skipUpdate = true;
  } else if (args[i] === "--tray" || args[i] === "-t") {
    trayMode = true;
    process.env.TRAY_MODE = "1";
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Usage: ${APP_NAME} [options]

Options:
  -p, --port <port>   Port to run the server (default: ${DEFAULT_PORT})
  -H, --host <host>   Host to bind (default: ${DEFAULT_HOST})
  -n, --no-browser    Don't open browser automatically
  -l, --log           Show server logs (default: hidden)
  -t, --tray          Run in system tray mode (background)
  --skip-update       Skip auto-update check
  -h, --help          Show this help message
  -v, --version       Show version
`);
    process.exit(0);
  } else if (args[i] === "--version" || args[i] === "-v") {
    console.log(pkg.version);
    process.exit(0);
  }
}

// A detached or piped CLI cannot answer the interactive menu. Keep it in the
// long-lived tray lifecycle even when it was launched without lifecycle flags.
if ((!process.stdin.isTTY || !process.stdout.isTTY) && !trayMode) {
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      cliPid: process.pid,
      cliPath: __filename,
      serverPid,
      serverPath,
      writtenAt: Date.now(),
    }), { mode: 0o600 });
  } catch { /* best effort */ }
}

function clearOwnedProcessState() {
  try {
    const state = readOwnedProcessState();
    if (Number(state.cliPid) === process.pid) fs.unlinkSync(getProcessStateFile());
  } catch { /* best effort */ }
}

function processMatchesRecordedPath(pid, expectedPath) {
  if (!expectedPath) return false;
  try {
    const command = process.platform === "win32"
      ? execSync(`powershell -NonInteractive -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine"`, { encoding: "utf8", windowsHide: true, timeout: 3000 })
      : execSync(`ps -p ${Number(pid)} -o command=`, { encoding: "utf8", timeout: 3000 });
    return command.includes(expectedPath);
  } catch {
    // If identity cannot be verified, fail closed rather than risking a PID
    // reuse killing an unrelated process.
    return false;
  }
}

function readOwnedAppPids() {
  const state = readOwnedProcessState();
  return [
    [state.serverPid, state.serverPath],
    [state.cliPid, state.cliPath],
  ]
    .filter(([, expectedPath]) => typeof expectedPath === "string" && expectedPath.length > 0)
    .map(([pid, expectedPath]) => [Number(pid), expectedPath])
    .filter(([pid, expectedPath]) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && processMatchesRecordedPath(pid, expectedPath))
    .map(([pid]) => pid);
}

// Kill PID from file (best-effort, removes file after)
function killByPidFile(pidFile) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { }
    try { fs.unlinkSync(pidFile); } catch { }
  } catch { }
}

// Kill tunnel processes (cloudflared/tailscale) by their PID files
function killTunnelByPidFile() {
  const tunnelDir = path.join(getAppDataDir(), "tunnel");
  killByPidFile(path.join(tunnelDir, "cloudflared.pid"));
  killByPidFile(path.join(tunnelDir, "tailscale.pid"));
}

// Kill only processes previously recorded by this launcher.
function killAllAppProcesses(appPort) {
  return new Promise((resolve) => {
    try {
      // Kill MIT first (privileged process, needs special handling)
      killProxyByPidFile();
      // Kill cloudflared/tailscale by PID file (precise, only this app's tunnel)
      killTunnelByPidFile();

      const platform = process.platform;
      const pids = readOwnedAppPids();

      // Gracefully stop owned processes, then force only survivors.
      if (pids.length > 0) {
        const uniquePids = [...new Set(pids.map(Number))];
        uniquePids.forEach(pid => {
          try {
            if (platform === "win32") {
              execSync(`taskkill /T /PID ${pid} 2>nul`, { stdio: 'ignore', shell: true, windowsHide: true, timeout: 3000 });
            } else {
              process.kill(pid, "SIGTERM");
            }
          } catch (err) {
            // Process already dead or can't kill - continue
          }
        });
        setTimeout(() => {
          uniquePids.forEach((pid) => {
            try {
              process.kill(pid, 0);
              if (platform === "win32") {
                execSync(`taskkill /F /T /PID ${pid} 2>nul`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
              } else {
                process.kill(pid, "SIGKILL");
              }
            } catch { /* already stopped */ }
          });
          try { fs.unlinkSync(getProcessStateFile()); } catch { }
          resolve();
        }, 2000);
      } else {
        resolve();
      }
    } catch (err) {
      // Silent fail - continue anyway
      resolve();
    }
  });
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
    try { fs.unlinkSync(pidFile); } catch { }
  } catch { }
}

function findListeningPids(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) return [];

  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${numericPort}`, {
        encoding: "utf8",
        shell: true,
        windowsHide: true,
        timeout: 5000,
      });
      return output.split("\n")
        .filter((line) => line.includes("LISTENING"))
        .filter((line) => line.trim().split(/\s+/).some((field) => field.endsWith(`:${numericPort}`)))
        .map((line) => Number(line.trim().split(/\s+/).pop()))
        .filter((pid) => Number.isInteger(pid) && pid > 1);
    }

    const output = execSync(`lsof -tiTCP:${numericPort} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output.split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return [];
  }
}

// Never kill an arbitrary listener that happens to share the app port. The
// launcher may only signal PIDs recorded in its ownership state file.
function killProcessOnPort(port) {
  const ownedPids = new Set(readOwnedAppPids());
  const pids = findListeningPids(port).filter((pid) => ownedPids.has(pid));
  if (pids.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const platform = process.platform;
    pids.forEach((pid) => {
      try {
        if (platform === "win32") {
          execSync(`taskkill /T /PID ${pid}`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch { /* already dead or inaccessible */ }
    });

    setTimeout(() => {
      pids.forEach((pid) => {
        try {
          process.kill(pid, 0);
          if (platform === "win32") {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch { /* already stopped */ }
      });
      resolve();
    }, 500);
  });
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

if (!fs.existsSync(serverPath)) {
  console.error("Error: Standalone build not found.");
  console.error("Please run 'npm run build:cli' first.");
  process.exit(1);
}

// Check for updates FIRST, then start server
checkForUpdate().then((latestVersion) => {
  killAllAppProcesses(port).then(() => {
    return killProcessOnPort(port);
  }).then(() => {
    startServer(latestVersion);
  });
});

// Show interface selection menu
async function showInterfaceMenu(latestVersion) {
  const { selectMenu } = require("./src/cli/utils/input");
  const { clearScreen } = require("./src/cli/utils/display");
  const { getEndpoint } = require("./src/cli/utils/endpoint");

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

  const menuItems = [];

  if (latestVersion) {
    menuItems.push({ label: `Update to v${latestVersion} (current: v${pkg.version})`, icon: "⬆" });
  }

  menuItems.push(
    { label: "Web UI (Open in Browser)", icon: "🌐" },
    { label: "Terminal UI (Interactive CLI)", icon: "💻" },
    { label: "Hide to Tray (Background)", icon: "🔔" },
    { label: "Exit", icon: "🚪" }
  );

  const selected = await selectMenu(`Choose Interface (v${pkg.version})`, menuItems, 0, subtitle);

  const offset = latestVersion ? 1 : 0;

  if (latestVersion && selected === 0) return "update";
  if (selected === offset) return "web";
  if (selected === offset + 1) return "terminal";
  if (selected === offset + 2) return "hide";
  return "exit";
}

const MAX_RESTARTS = 2;
const RESTART_RESET_MS = 30000; // Reset counter if alive > 30s

function startServer(latestVersion) {
  const displayHost = getDisplayHost();
  const url = `http://${displayHost}:${port}/dashboard`;
  // Surface real network exposure when bound to all interfaces (explicit opt-in).
  if (host === ALL_INTERFACES || host === "::") {
    const lanIp = getLanIp();
    if (lanIp) console.log(`\x1b[33m⚠ Network-exposed: reachable at http://${lanIp}:${port} (bound ${host}). Use --host 127.0.0.1 for local-only. Non-loopback /v1 requires an API key by default.\x1b[0m`);
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
      stdio: showLog ? "inherit" : ["ignore", "ignore", "pipe"],
      detached: true,
      windowsHide: true,
      env: {
        ...buildEnvWithRuntime(process.env),
        PORT: port.toString(),
        HOSTNAME: host
      }
    });
    if (child.pid) writeOwnedProcessState(child.pid);
    if (!showLog && child.stderr) {
      child.stderr.on("data", (data) => {
        const lines = data.toString().split("\n").filter(Boolean);
        crashLog.push(...lines);
        if (crashLog.length > CRASH_LOG_LINES) crashLog = crashLog.slice(-CRASH_LOG_LINES);
      });
    }
    return child;
  }

  let server = spawnServer();

  // Cleanup function - graceful SIGTERM → wait → SIGKILL
  let isCleaningUp = false;
  function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    try {
      // Kill tray if running
      try {
        const { killTray } = require("./src/cli/tray/tray");
        killTray();
      } catch (e) { }
      // Kill MIT server (privileged process) via PID file
      killProxyByPidFile();
      // Kill cloudflared/tailscale via PID file (only this app's tunnel)
      killTunnelByPidFile();
      // Graceful shutdown: SIGTERM first so server can flush DB, then SIGKILL
      if (server.pid) {
        try { process.kill(server.pid, "SIGTERM"); } catch { }
        if (!waitForExit(server.pid, 2000)) {
          try { process.kill(server.pid, "SIGKILL"); } catch { }
        }
        // Also try to kill process group
        try { process.kill(-server.pid, "SIGKILL"); } catch { }
      }
      clearOwnedProcessState();
    } catch (e) { }
  }

  // Suppress all errors during shutdown (systray lib throws JSON parse errors)
  let isShuttingDown = false;
  process.on("uncaughtException", (err) => {
    if (isShuttingDown) return;
    console.error("Error:", err.message);
  });

  // Handle all exit scenarios
  process.on("SIGINT", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\nExiting...");
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGTERM", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });
  process.on("SIGHUP", () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    cleanup();
    setTimeout(() => process.exit(0), 100);
  });

  // Initialize tray icon (runs alongside TUI)
  const initTrayIcon = () => {
    try {
      const { initTray } = require("./src/cli/tray/tray");
      initTray({
        port,
        onQuit: () => {
          isShuttingDown = true;
          console.log("\n👋 Shutting down from tray...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        },
        onOpenDashboard: () => openBrowser(url)
      });
    } catch (err) {
      // Tray not available - continue without it
    }
  };

  // Tray-only mode: no TUI, just tray icon
  if (trayMode) {
    // Ignore SIGHUP so macOS terminal close doesn't kill the background tray process
    process.removeAllListeners("SIGHUP");
    process.on("SIGHUP", () => {});

    console.log(`\n🚀 ${pkg.name} v${pkg.version}`);
    console.log(`Server: http://${displayHost}:${port}`);

    setTimeout(() => {
      initTrayIcon();
      console.log("\n💡 Router is now running in system tray. Close this terminal if you want.");
      console.log("   Right-click tray icon to open dashboard or quit.\n");
    }, 2000);

    return;
  }

  // Wait for server to be ready, then show interface menu loop + tray
  setTimeout(async () => {
    // Start tray icon alongside TUI
    initTrayIcon();

    try {
      while (true) {
        const choice = await showInterfaceMenu(latestVersion);

        if (choice === "update") {
          isShuttingDown = true;
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();
          console.log(`\n⬆  Update v${pkg.version} → v${latestVersion}\n`);
          console.log(`Run this after exit:\n`);
          console.log(`   \x1b[33m${INSTALL_CMD_LATEST}\x1b[0m\n`);
          cleanup();
          await killAllAppProcesses(port);
          await killProcessOnPort(port);
          setTimeout(() => process.exit(0), 200);
          return;
        } else if (choice === "web") {
          openBrowser(url);
          // Wait for user to come back
          const { pause } = require("./src/cli/utils/input");
          await pause("\nPress Enter to go back to menu...");
        } else if (choice === "terminal") {
          // Start Terminal UI - it will return when user selects Back
          const { startTerminalUI } = require("./src/cli/terminalUI");
          await startTerminalUI(port);
          // Loop continues, show menu again
        } else if (choice === "hide") {
          const { clearScreen } = require("./src/cli/utils/display");
          clearScreen();

          // Enable auto startup on OS boot
          try {
            const { enableAutoStart } = require("./src/cli/tray/autostart");
            enableAutoStart(__filename);
          } catch (e) { }

          if (process.platform === "darwin") {
            // macOS: keep current process alive — spawning a detached child puts
            // it outside the login session so NSStatusItem silently fails.
            process.removeAllListeners("SIGHUP");
            process.on("SIGHUP", () => {});

            console.log(`\n⏳ Switching to tray mode... (icon already visible in menu bar)`);
            console.log(`🔔 Switchboard is running in tray (PID: ${process.pid})`);
            console.log(`   Server: http://${displayHost}:${port}`);
            console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

            // Tray already init'd at startup — just keep event loop alive.
            return;
          }

          // Windows/Linux: spawn detached bgProcess (systray works fine in child)
          console.log(`\n⏳ Starting background process... (tray icon will appear in ~3s)`);

          const bgProcess = spawn(process.execPath, [__filename, "--tray", "--skip-update", "-p", port.toString()], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env }
          });
          bgProcess.unref();

          console.log(`🔔 Switchboard is now running in background (PID: ${bgProcess.pid})`);
          console.log(`   Server: http://${displayHost}:${port}`);
          console.log(`\n💡 You can close this terminal. Right-click tray icon to quit.\n`);

          // cleanup() kills server so bgProcess can claim the port fresh
          cleanup();
          process.exit(0);
        } else if (choice === "exit") {
          isShuttingDown = true;
          console.log("\nExiting...");
          cleanup();
          setTimeout(() => process.exit(0), 100);
        }
      }
    } catch (err) {
      console.error("Error:", err.message);
      cleanup();
      process.exit(1);
    }
  }, 3000);

  function attachServerEvents() {
    server.on("error", (err) => {
      console.error("Failed to start server:", err.message);
      if (err?.code === "EADDRINUSE") stopForPortConflict();
      else if (!isShuttingDown) tryRestart();
      else { cleanup(); process.exit(1); }
    });

    server.on("close", (code) => {
      if (isShuttingDown || code === 0) {
        process.exit(code || 0);
        return;
      }
      if (isPortConflict()) {
        stopForPortConflict();
        return;
      }
      tryRestart(code);
    });
  }

  let mitmResetDone = false;

  function isPortConflict() {
    return crashLog.some((line) => /EADDRINUSE|address already in use|listen .*already in use/i.test(line));
  }

  function stopForPortConflict() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`\n❌ Port ${port} is already in use. Stop the other listener or choose a different port.`);
    cleanup();
    process.exit(1);
  }

  function tryRestart(code) {
    if (isPortConflict()) {
      stopForPortConflict();
      return;
    }
    const aliveMs = Date.now() - serverStartTime;
    // Reset counter if last run was stable
    if (aliveMs >= RESTART_RESET_MS) restartCount = 0;

    if (restartCount >= MAX_RESTARTS) {
      // Already tried MITM reset and still crashing — exit non-zero
      if (mitmResetDone) {
        console.error(`\n❌ Server still crashing after MITM reset. Giving up.`);
        console.error(`   Data directory: ${getAppDataDir()}`);
        if (crashLog.length) {
          console.error("\n--- Server crash log ---");
          crashLog.forEach(l => console.error(l));
          console.error("--- End crash log ---\n");
        }
        cleanup();
        process.exit(1);
      }
      console.error(`\n⚠️  Server crashed ${MAX_RESTARTS} times. Disabling MIT and restarting...`);
      if (!disableMitm()) {
        console.error("❌ Could not disable MIT in the database — refusing to restart into the same crash.");
        console.error(`   Data directory: ${getAppDataDir()}`);
        process.exit(1);
      }
      mitmResetDone = true;
      restartCount = 0;
      server = spawnServer();
      attachServerEvents();
      return;
    }

    restartCount++;
    const delay = Math.min(1000 * restartCount, 10000);
    console.error(`\n⚠️  Server exited (code=${code ?? "unknown"}). Restarting in ${delay / 1000}s... (${restartCount}/${MAX_RESTARTS})`);
    if (crashLog.length) {
      console.error("\n--- Server crash log ---");
      crashLog.forEach(l => console.error(l));
      console.error("--- End crash log ---\n");
    }

    setTimeout(() => {
      server = spawnServer();
      attachServerEvents();
    }, delay);
  }

  attachServerEvents();
}
