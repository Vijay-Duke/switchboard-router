import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";
import { registerAdapterCloser } from "./adapterShutdownRegistry.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

  function persist() {
    const data = db.export();
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(data));
    const fileFd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fileFd);
    } finally {
      fs.closeSync(fileFd);
    }
    fs.renameSync(tmp, filePath);
    // Persist the directory entry as well. This is required for the rename to
    // survive a power loss on filesystems that journal file data separately.
    let dirFd;
    try {
      dirFd = fs.openSync(path.dirname(filePath), "r");
      fs.fsyncSync(dirFd);
    } catch {
      // Some platforms (notably Windows) do not allow opening directories.
    } finally {
      if (dirFd !== undefined) fs.closeSync(dirFd);
    }
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  let closed = false;
  function close() {
    unregisterClose();
    if (closed) return;
    closed = true;
    clearTimeout(saveTimer);
    try {
      if (dirty) persist();
    } finally {
      db.close();
    }
  }

  // Flush on shutdown: the registry runs this on beforeExit AND on
  // SIGTERM/SIGINT (synchronously, before re-raising the signal).
  const unregisterClose = registerAdapterCloser(close);

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
