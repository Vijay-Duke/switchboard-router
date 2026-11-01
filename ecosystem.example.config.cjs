// PM2 supervision for a standalone build (`npm run build` first).
// Copy to ecosystem.config.cjs (gitignored, host-local) and `pm2 start` it.
//
// PM2 runs the actual HTTP server (custom-server.js → server.js) directly, so
// a fatal server exit reaches PM2 and autorestart fires. Do NOT point PM2 at
// a wrapper/launcher that spawns the server as a child and stays alive: on
// 2026-11-01 the server aborted (V8 heap OOM, SIGABRT) while its launcher
// parent survived, so PM2 never restarted anything.
//
// Memory layering, innermost first:
//   1. In-app watchdog (src/lib/memoryWatchdog.js) flushes and exits(1) on
//      sustained heap pressure — cleanest restart, no lost state.
//   2. V8 old-space limit below (--max-old-space-size) aborts if the watchdog
//      somehow misses; --report-on-fatalerror leaves a diagnostic report.
//   3. PM2 max_memory_restart (RSS) sits ABOVE the heap limit as a backstop
//      for non-heap growth (Buffers, native). Never set it below the heap
//      limit or PM2 will SIGKILL healthy-but-large heaps mid-request.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
const standaloneDir = path.join(root, ".next", "standalone");
const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".switchboard");
const reportDir = path.join(dataDir, "diagnostic-reports");
try { fs.mkdirSync(reportDir, { recursive: true }); } catch { /* report flag degrades silently */ }

// Half of host RAM clamped to [512, 6144] MB — mirrors scripts/heapSizing.mjs.
const overrideMb = Number.parseInt(process.env.SWITCHBOARD_MAX_OLD_SPACE_MB || "", 10);
const heapMb = Number.isFinite(overrideMb) && overrideMb >= 256
  ? overrideMb
  : Math.min(6144, Math.max(512, Math.floor(os.totalmem() / (1024 * 1024) / 2)));

module.exports = {
  apps: [{
    name: "switchboard",
    script: path.join(standaloneDir, "custom-server.js"),
    cwd: standaloneDir,
    interpreter: "node",
    node_args: [
      `--max-old-space-size=${heapMb}`,
      "--report-on-fatalerror",
      `--report-directory=${reportDir}`,
    ],
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    stop_exit_codes: [],
    min_uptime: 10000,
    max_restarts: 100,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: `${heapMb + 1024}M`,
    kill_timeout: 10000,
    treekill: true,
    time: true,
    env: {
      NODE_ENV: "production",
      PORT: process.env.PORT || "20128",
      // Loopback by default; set HOSTNAME=0.0.0.0 only behind a trusted
      // network boundary (VPN, reverse proxy on the same host).
      HOSTNAME: process.env.HOSTNAME || "127.0.0.1",
      DATA_DIR: dataDir,
    },
  }],
};
