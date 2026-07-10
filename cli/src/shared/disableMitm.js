// Crash-loop recovery: turn off mitmEnabled in the live store.
//
// Settings live in $DATA_DIR/db/data.sqlite as a single JSON blob (settings.id=1);
// db.json is legacy migration input the server no longer reads. Writing db.json
// silently no-ops on a current install, so a MITM-induced crash loops forever.
//
// The server owns this schema, but it is dead by the time we get here, so the CLI
// touches SQLite directly through whichever driver is available: node:sqlite
// (built in from Node 22.5), then better-sqlite3 installed into
// $DATA_DIR/runtime. Legacy JSON is used only when no SQLite store exists.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { getDataDir } = require("./dataDir");

function dbFile(dataDir) {
  return path.join(dataDir, "db", "data.sqlite");
}

/** @returns {{read: (sql: string) => any, write: (sql: string, params: any[]) => any, close: () => void} | null} */
function openSqlite(file, dataDir) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file);
    return {
      read: (sql) => db.prepare(sql).get(),
      write: (sql, params) => db.prepare(sql).run(...params),
      close: () => db.close(),
    };
  } catch { /* Node < 22.5, or node:sqlite unavailable */ }

  // The published CLI deliberately installs native dependencies outside its
  // own package tree so global upgrades do not hit Windows EBUSY locks. NODE_PATH
  // is added to the spawned server, not this already-running CLI process, so a
  // plain require() cannot see that package on Node versions without node:sqlite.
  const runtimeRequire = createRequire(path.resolve(dataDir, "runtime", "package.json"));
  const loaders = [
    () => runtimeRequire("better-sqlite3"),
    () => require("better-sqlite3"), // development checkout / conventional install
  ];
  for (const load of loaders) {
    try {
      const Database = load();
      const db = new Database(file, { fileMustExist: true });
      return {
        read: (sql) => db.prepare(sql).get(),
        write: (sql, params) => db.prepare(sql).run(...params),
        close: () => db.close(),
      };
    } catch { /* package or native bindings absent — try the next location */ }
  }

  return null;
}

function disableViaSqlite(file, dataDir) {
  if (!fs.existsSync(file)) return false;
  const db = openSqlite(file, dataDir);
  if (!db) return false;
  try {
    const row = db.read("SELECT data FROM settings WHERE id = 1");
    if (!row || !row.data) return false;
    const settings = JSON.parse(row.data);
    if (settings.mitmEnabled === false) return true; // already off — nothing to write
    settings.mitmEnabled = false;
    const result = db.write("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(settings)]);
    return Number(result?.changes) > 0;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function disableViaLegacyJson(dataDir) {
  const file = path.join(dataDir, "db.json");
  if (!fs.existsSync(file)) return false;
  try {
    const db = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!db.settings) return false;
    db.settings.mitmEnabled = false;
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} [dataDir] defaults to the pinned data directory
 * @returns {boolean} true only when mitmEnabled is now false on disk
 */
function disableMitm(dataDir = getDataDir()) {
  const sqlite = dbFile(dataDir);
  // Once SQLite exists it is the source of truth, even when it is damaged,
  // locked, or unreadable. Falling through to retained migration JSON would
  // report success without changing the setting the server reads.
  if (fs.existsSync(sqlite)) return disableViaSqlite(sqlite, dataDir);
  return disableViaLegacyJson(dataDir);
}

module.exports = { disableMitm };
