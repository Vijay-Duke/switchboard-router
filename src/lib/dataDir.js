import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "switchboard";
const LEGACY_APP_NAME = "9router";

function dirLooksPopulated(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    // Prefer real SQLite; also accept legacy JSON installs
    if (fs.existsSync(path.join(dir, "db", "data.sqlite"))) return true;
    if (fs.existsSync(path.join(dir, "db.json"))) return true;
    const dbDir = path.join(dir, "db");
    if (fs.existsSync(dbDir)) {
      const entries = fs.readdirSync(dbDir);
      if (entries.some((e) => e.endsWith(".sqlite") || e === "data.sqlite")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function defaultDir() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const modern = path.join(base, APP_NAME);
    const legacy = path.join(base, LEGACY_APP_NAME);
    if (dirLooksPopulated(modern)) return modern;
    if (dirLooksPopulated(legacy)) {
      console.warn(
        `[DATA_DIR] Using legacy path ${legacy} (rename to ${modern} or set DATA_DIR to migrate)`
      );
      return legacy;
    }
    return modern;
  }
  const modern = path.join(os.homedir(), `.${APP_NAME}`);
  const legacy = path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
  if (dirLooksPopulated(modern)) return modern;
  if (dirLooksPopulated(legacy)) {
    console.warn(
      `[DATA_DIR] Using legacy path ${legacy} (copy/rename to ${modern} or set DATA_DIR to migrate)`
    );
    return legacy;
  }
  return modern;
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
