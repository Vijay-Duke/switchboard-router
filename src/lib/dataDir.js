import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "switchboard";
const LEGACY_APP_NAME = "9router";

function appDir(name) {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, name);
  }
  return path.join(os.homedir(), `.${name}`);
}

// Real application state, as opposed to caches the CLI creates before the server
// ever runs (`runtime/` from the npm postinstall, `bin/`, `logs/`). Treating any
// directory entry as "populated" would let that warm-up hide a legacy database.
const STATE_ENTRIES = [
  "db/data.sqlite",
  "machine-id",
  "jwt-secret",
  "auth",
  "db.json", // pre-SQLite installs
];

export function hasAppState(dir) {
  return STATE_ENTRIES.some((entry) => fs.existsSync(path.join(dir, entry)));
}

/**
 * Adopt the legacy 9router directory in place when the new one holds no state.
 * Nothing is copied: an existing install keeps its providers, keys and history,
 * and the old directory stays intact if the user downgrades.
 */
function defaultDir() {
  const current = appDir(APP_NAME);
  if (hasAppState(current)) return current;
  const legacy = appDir(LEGACY_APP_NAME);
  if (hasAppState(legacy)) {
    console.warn(`[DATA_DIR] using legacy data directory '${legacy}' (set DATA_DIR='${current}' to switch)`);
    return legacy;
  }
  return current;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
