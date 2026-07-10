// CommonJS mirror of src/lib/dataDir.js. The CLI runs before (and beside) the
// server, so both must resolve the same directory — otherwise the CLI signs a
// token with the machine-id / cli-secret from one directory while the server
// validates against another. The two implementations cannot be merged (the
// server is ESM and ships without cli/), so the whole resolution contract is
// duplicated here and pinned by tests/unit/data-dir.test.js.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "switchboard";
const LEGACY_APP_NAME = "9router";

// Real application state, not caches the CLI creates before first server run
// (`runtime/` from npm postinstall, `bin/`, `logs/`).
const STATE_ENTRIES = ["db/data.sqlite", "machine-id", "jwt-secret", "auth", "db.json"];

function appDir(name) {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, name);
  }
  return path.join(os.homedir(), `.${name}`);
}

function hasAppState(dir) {
  return STATE_ENTRIES.some((entry) => fs.existsSync(path.join(dir, entry)));
}

function defaultDir() {
  const current = appDir(APP_NAME);
  if (hasAppState(current)) return current;
  const legacy = appDir(LEGACY_APP_NAME);
  if (hasAppState(legacy)) return legacy;
  return current;
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) return defaultDir();

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e && (e.code === "EACCES" || e.code === "EPERM")) return defaultDir();
    throw e;
  }
}

/** Resolve once and pin it, so every child process inherits the same directory. */
function pinDataDir() {
  process.env.DATA_DIR = getDataDir();
  return process.env.DATA_DIR;
}

module.exports = { getDataDir, pinDataDir, hasAppState, appDir, APP_NAME, LEGACY_APP_NAME };
