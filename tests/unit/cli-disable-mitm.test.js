// Crash-loop recovery must turn mitmEnabled off in the store the SERVER reads.
// The old code wrote $DATA_DIR/db.json, which a current install does not have —
// so it "succeeded", reset the restart counter, and looped on the same crash.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { disableMitm } = require("../../cli/src/shared/disableMitm.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** node:sqlite is built in from Node 22.5 — the same driver the helper prefers. */
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

let dir;

function seedSqlite(settings) {
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)");
  db.prepare("INSERT INTO settings(id, data) VALUES(1, ?)").run(JSON.stringify(settings));
  db.close();
}

function readSqlite() {
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  db.close();
  return JSON.parse(row.data);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-mitm-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!DatabaseSync)("disableMitm", () => {
  it("clears mitmEnabled in the live SQLite settings row", () => {
    seedSqlite({ mitmEnabled: true, rtkEnabled: true });

    expect(disableMitm(dir)).toBe(true);
    expect(readSqlite().mitmEnabled).toBe(false);
  });

  it("leaves every other setting untouched", () => {
    seedSqlite({ mitmEnabled: true, rtkEnabled: true, comboStrategy: "fallback" });

    disableMitm(dir);

    const after = readSqlite();
    expect(after.rtkEnabled).toBe(true);
    expect(after.comboStrategy).toBe("fallback");
  });

  it("is idempotent when MITM is already off", () => {
    seedSqlite({ mitmEnabled: false });
    expect(disableMitm(dir)).toBe(true);
  });

  it("reports failure when there is no store to write", () => {
    // cli.js refuses to restart on false — restarting would repeat the crash.
    expect(disableMitm(dir)).toBe(false);
  });

  it("reports failure when the settings row is missing", () => {
    fs.mkdirSync(path.join(dir, "db"), { recursive: true });
    const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
    db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)");
    db.close();

    expect(disableMitm(dir)).toBe(false);
  });

  it("still handles a legacy db.json install", () => {
    fs.writeFileSync(
      path.join(dir, "db.json"),
      JSON.stringify({ settings: { mitmEnabled: true, rtkEnabled: true } })
    );

    expect(disableMitm(dir)).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
    expect(after.settings.mitmEnabled).toBe(false);
    expect(after.settings.rtkEnabled).toBe(true);
  });

  it("prefers SQLite over a stale db.json left behind by migration", () => {
    seedSqlite({ mitmEnabled: true });
    fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ settings: { mitmEnabled: true } }));

    expect(disableMitm(dir)).toBe(true);
    expect(readSqlite().mitmEnabled).toBe(false);
    // The legacy file is not the source of truth and must not be touched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8")).settings.mitmEnabled).toBe(true);
  });

  it("does not report success from stale db.json when the live SQLite write fails", () => {
    fs.mkdirSync(path.join(dir, "db"), { recursive: true });
    const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
    db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)");
    db.close();
    fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ settings: { mitmEnabled: true } }));

    expect(disableMitm(dir)).toBe(false);
    // Once SQLite exists it is authoritative. Mutating retained migration input
    // would make cli.js restart even though the server's live setting stayed on.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8")).settings.mitmEnabled).toBe(true);
  });

  it("resolves better-sqlite3 from DATA_DIR/runtime in a packaged CLI layout", () => {
    const packageRoot = path.join(dir, "package");
    const sharedDir = path.join(packageRoot, "cli", "src", "shared");
    const helperPath = path.join(sharedDir, "disableMitm.js");
    const runtimePackage = path.join(dir, "runtime", "node_modules", "better-sqlite3");
    const sqliteFile = path.join(dir, "db", "data.sqlite");
    const marker = path.join(dir, "written-settings.json");
    const preload = path.join(dir, "without-node-sqlite.cjs");
    const probe = path.join(dir, "probe.cjs");

    fs.mkdirSync(sharedDir, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "cli", "src", "shared", "disableMitm.js"), helperPath);
    fs.copyFileSync(path.join(repoRoot, "cli", "src", "shared", "dataDir.js"), path.join(sharedDir, "dataDir.js"));
    fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
    fs.writeFileSync(sqliteFile, "stub database");

    fs.mkdirSync(runtimePackage, { recursive: true });
    fs.writeFileSync(path.join(runtimePackage, "package.json"), JSON.stringify({
      name: "better-sqlite3",
      version: "0.0.0-test",
      main: "index.js",
    }));
    fs.writeFileSync(path.join(runtimePackage, "index.js"), `
      const fs = require("node:fs");
      module.exports = class Database {
        prepare(sql) {
          if (sql.startsWith("SELECT")) {
            return { get: () => ({ data: JSON.stringify({ mitmEnabled: true, sibling: "kept" }) }) };
          }
          return { run: (data) => { fs.writeFileSync(process.env.WRITE_MARKER, data); return { changes: 1 }; } };
        }
        close() {}
      };
    `);
    fs.writeFileSync(preload, `
      const Module = require("node:module");
      const originalLoad = Module._load;
      Module._load = function(request) {
        if (request === "node:sqlite") throw Object.assign(new Error("disabled for test"), { code: "MODULE_NOT_FOUND" });
        return originalLoad.apply(this, arguments);
      };
    `);
    fs.writeFileSync(probe, `
      const fs = require("node:fs");
      const { disableMitm } = require(process.env.HELPER_PATH);
      const ok = disableMitm(process.env.TEST_DATA_DIR);
      console.log(JSON.stringify({ ok, marker: fs.existsSync(process.env.WRITE_MARKER) }));
    `);

    const result = spawnSync(process.execPath, ["-r", preload, probe], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_PATH: "",
        HELPER_PATH: helperPath,
        // Explicit DATA_DIR is allowed to be relative; createRequire still needs
        // an absolute filename when resolving the runtime dependency package.
        TEST_DATA_DIR: path.relative(packageRoot, dir),
        WRITE_MARKER: marker,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, marker: true });
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ mitmEnabled: false, sibling: "kept" });
  });
});
