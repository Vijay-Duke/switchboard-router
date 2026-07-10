import { ensureDirs, DATA_FILE, BACKUPS_DIR } from "./paths.js";
import { isBuildPhase } from "@/lib/buildPhase.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryBunSqlite(failures) {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    failures.push(e);
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite(failures) {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    failures.push(e);
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite(failures) {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    failures.push(e);
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs(failures) {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    failures.push(e);
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  // `next build` must never open the operator's database: it would run migrations
  // against live data and bake the result into static output. Every page that
  // reads the DB is `force-dynamic`, so reaching this during a build is a bug.
  if (isBuildPhase()) {
    throw new Error(
      `[DB] refusing to open ${DATA_FILE} during next build — mark the calling page 'force-dynamic'`
    );
  }
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  const failures = [];
  let adapter = await tryBunSqlite(failures);
  if (!adapter) adapter = await tryBetterSqlite(failures);
  if (!adapter) adapter = await tryNodeSqlite(failures);
  if (!adapter) adapter = await trySqlJs(failures);
  if (!adapter) {
    const corrupt = failures.some((error) =>
      error?.code === "SQLITE_CORRUPT" || /corrupt|malformed|not a database/i.test(error?.message || "")
    );
    if (corrupt) {
      throw new Error(`[DB] Database appears corrupted: ${DATA_FILE}. Restore one of the five automatic backups from ${BACKUPS_DIR}.`);
    }
    throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");
  }

  if (!state.logged) {
    const level = adapter.driver === "sql.js" ? "warn" : "log";
    // M2: sql.js is last-resort — full-DB rewrite on every write burst
    if (adapter.driver === "sql.js") {
      console.warn(
        `[DB] WARNING: using sql.js fallback (in-memory + full-file rewrite). Prefer Node ≥22.5 (node:sqlite) or install better-sqlite3. file: ${DATA_FILE}`
      );
    } else {
      console[level](`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    }
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export async function closeAdapter() {
  const adapter = state.instance || (state.initPromise ? await state.initPromise.catch(() => null) : null);
  if (!adapter) return;
  try { adapter.close?.(); } finally {
    state.instance = null;
    state.initPromise = null;
  }
}
