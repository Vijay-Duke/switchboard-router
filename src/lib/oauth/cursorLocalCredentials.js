// @ts-check
import { access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"];
const MACHINE_ID_KEYS = [
  "storage.serviceMachineId",
  "storage.machineId",
  "telemetry.machineId",
];

/** @param {string} value */
function normalize(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** @param {NodeJS.Platform} platform */
export function getCursorDatabaseCandidates(platform = process.platform) {
  const home = homedir();
  if (platform === "darwin") {
    return [
      join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
      join(home, "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb"),
    ];
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(appData, "Cursor - Insiders", "User", "globalStorage", "state.vscdb"),
      join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(localAppData, "Programs", "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
  }
  return [
    join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    join(home, ".config/cursor/User/globalStorage/state.vscdb"),
  ];
}

/** @param {string} dbPath */
async function extractViaBetterSqlite(dbPath) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const keys = [...ACCESS_TOKEN_KEYS, ...MACHINE_ID_KEYS];
    const placeholders = keys.map(() => "?").join(", ");
    const exactRows = db.prepare(
      `SELECT key, value FROM itemTable WHERE key IN (${placeholders})`,
    ).all(...keys);
    const values = new Map(exactRows.map(({ key, value }) => [key, normalize(value)]));
    let accessToken = ACCESS_TOKEN_KEYS.map((key) => values.get(key)).find(Boolean) || null;
    let machineId = MACHINE_ID_KEYS.map((key) => values.get(key)).find(Boolean) || null;

    if (!accessToken || !machineId) {
      const fuzzyRows = db.prepare(
        "SELECT key, value FROM itemTable WHERE key LIKE ? OR key LIKE ?",
      ).all("%accessToken%", "%machineId%");
      for (const { key, value } of fuzzyRows) {
        const normalized = normalize(value);
        if (!accessToken && /access.?token/i.test(key)) accessToken = normalized;
        if (!machineId && /machine.?id/i.test(key)) machineId = normalized;
      }
    }
    return { accessToken, machineId };
  } finally {
    db.close();
  }
}

/** @param {string} dbPath */
async function extractViaCli(dbPath) {
  const query = async (sql) => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], { timeout: 10000 });
    return stdout.trim();
  };
  try {
    await query("SELECT 1 FROM itemTable LIMIT 1");
  } catch {
    return { accessToken: null, machineId: null, opened: false };
  }

  let accessToken = null;
  for (const key of ACCESS_TOKEN_KEYS) {
    try {
      const raw = await query(`SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`);
      if (raw) { accessToken = normalize(raw.trim()); break; }
    } catch { /* try next key */ }
  }
  let machineId = null;
  for (const key of MACHINE_ID_KEYS) {
    try {
      const raw = await query(`SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`);
      if (raw) { machineId = normalize(raw.trim()); break; }
    } catch { /* try next key */ }
  }
  return { accessToken, machineId, opened: true };
}

/**
 * Read the current credentials owned by the locally installed Cursor IDE.
 * This is also Cursor's refresh mechanism: imported access tokens do not have
 * a public refresh token, but Cursor rotates the value in state.vscdb.
 *
 * @param {{ platform?: NodeJS.Platform, verifyLinuxInstall?: boolean }} [options]
 */
export async function readLocalCursorCredentials(options = {}) {
  const platform = options.platform || process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) {
    return { found: false, error: "Unsupported platform" };
  }

  const candidates = getCursorDatabaseCandidates(platform);
  let dbPath = null;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      dbPath = candidate;
      break;
    } catch { /* try next candidate */ }
  }
  if (!dbPath) {
    const location = platform === "darwin" ? "known macOS locations" : "known locations";
    return {
      found: false,
      error: `Cursor database not found in ${location}:\n${candidates.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`,
    };
  }

  if (platform === "linux" && options.verifyLinuxInstall !== false) {
    let installed = false;
    try {
      await execFileAsync("which", ["cursor"], { timeout: 5000 });
      installed = true;
    } catch {
      try {
        await access(join(homedir(), ".local/share/applications/cursor.desktop"), constants.R_OK);
        installed = true;
      } catch { /* not installed */ }
    }
    if (!installed) {
      return { found: false, error: "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import." };
    }
  }

  let sqliteError = null;
  try {
    const tokens = await extractViaBetterSqlite(dbPath);
    if (tokens.accessToken && tokens.machineId) return { found: true, ...tokens, dbPath };
  } catch (error) {
    sqliteError = error;
  }

  let cliOpenedDb = false;
  try {
    const tokens = await extractViaCli(dbPath);
    cliOpenedDb = tokens.opened;
    if (tokens.accessToken && tokens.machineId) {
      return { found: true, accessToken: tokens.accessToken, machineId: tokens.machineId, dbPath };
    }
  } catch { /* sqlite3 CLI unavailable */ }

  if (sqliteError && !cliOpenedDb) {
    return { found: false, error: `Cursor database was found but could not open it: ${sqliteError.message}` };
  }
  return {
    found: false,
    windowsManual: platform === "win32",
    error: "Please login to Cursor IDE first, then restart Switchboard to import its credentials.",
    dbPath,
  };
}
