// @ts-check
import { NextResponse } from "next/server";
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

/** Get candidate db paths by platform */
function getCandidatePaths(platform) {
  const home = homedir();

  if (platform === "darwin") {
    return [
      join(
        home,
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      ),
      join(
        home,
        "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
      ),
    ];
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        appData,
        "Cursor - Insiders",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        localAppData,
        "Programs",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ];
  }

  return [
    join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    join(home, ".config/cursor/User/globalStorage/state.vscdb"),
  ];
}

const normalize = (value) => {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * Extract tokens via better-sqlite3.
 * Preferred strategy — no external CLI required. The package is OPTIONAL: the
 * packaged CLI strips it and reinstalls it best-effort, so it is imported here
 * rather than at module scope. A top-level import would fail the whole route
 * before the sqlite3-CLI fallback could run.
 */
async function extractTokensViaBetterSqlite(dbPath) {
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

/**
 * Extract tokens via sqlite3 CLI.
 * Fallback when better-sqlite3 native bindings are unavailable.
 * Returns `opened: false` when sqlite3 is missing or the database is unreadable —
 * the caller must not report "could not open" once some strategy has read it.
 */
async function extractTokensViaCLI(dbPath) {
  const normalize = (raw) => {
    const value = raw.trim();
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  };

  const query = async (sql) => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
      timeout: 10000,
    });
    return stdout.trim();
  };

  // Probe the table we actually need. `SELECT 1` would succeed on an empty or
  // non-Cursor SQLite file, and every itemTable query below is swallowed — so
  // the user would be told to log in when the real problem is the schema.
  try {
    await query("SELECT 1 FROM itemTable LIMIT 1");
  } catch {
    return { accessToken: null, machineId: null, opened: false };
  }

  // Try each key in priority order
  let accessToken = null;
  for (const key of ACCESS_TOKEN_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        accessToken = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  let machineId = null;
  for (const key of MACHINE_ID_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        machineId = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  return { accessToken, machineId, opened: true };
}

/**
 * GET /api/oauth/cursor/auto-import
 * Auto-detect and extract Cursor tokens from local SQLite database.
 * Strategy: better-sqlite3 → sqlite3 CLI → manual fallback
 */
export async function GET() {
  try {
    const platform = process.platform;
    if (!["darwin", "win32", "linux"].includes(platform)) {
      return NextResponse.json(
        { found: false, error: "Unsupported platform" },
        { status: 400 },
      );
    }
    const candidates = getCandidatePaths(platform);

    let dbPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        dbPath = candidate;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!dbPath) {
      const location = platform === "darwin" ? "known macOS locations" : "known locations";
      return NextResponse.json({
        found: false,
        error: `Cursor database not found in ${location}:\n${candidates.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`,
      });
    }

    // On Linux, verify Cursor is actually installed (not just leftover config)
    if (platform === "linux") {
      let cursorInstalled = false;
      try {
        await execFileAsync("which", ["cursor"], { timeout: 5000 });
        cursorInstalled = true;
      } catch {
        try {
          const desktopFile = join(homedir(), ".local/share/applications/cursor.desktop");
          await access(desktopFile, constants.R_OK);
          cursorInstalled = true;
        } catch { /* not found */ }
      }
      if (!cursorInstalled) {
        return NextResponse.json({
          found: false,
          error: "Cursor config files found but Cursor IDE does not appear to be installed. Skipping auto-import.",
        });
      }
    }

    // Strategy 1: better-sqlite3 (bundled — no external tools required)
    let sqliteError = null;
    try {
      const tokens = await extractTokensViaBetterSqlite(dbPath);
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch (error) {
      // Native bindings unavailable — try CLI fallback
      sqliteError = error;
    }

    // Strategy 2: sqlite3 CLI
    let cliOpenedDb = false;
    try {
      const tokens = await extractTokensViaCLI(dbPath);
      cliOpenedDb = tokens.opened;
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch {
      // sqlite3 CLI not available either
    }

    // Strategy 3: ask user to paste manually. Only claim the DB is unreadable
    // when every strategy failed to open it — a readable DB with no token pair
    // means the user has not logged in to Cursor.
    if (sqliteError && !cliOpenedDb) {
      return NextResponse.json({
        found: false,
        error: `Cursor database was found but could not open it: ${sqliteError.message}`,
      });
    }

    return NextResponse.json({
      found: false,
      windowsManual: platform === "win32",
      error: "Please login to Cursor IDE first, then restart Switchboard to import its credentials.",
      dbPath,
    });
  } catch (error) {
    console.log("Cursor auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
