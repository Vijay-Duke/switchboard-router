import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function toFileUrl(p) {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return `file://${resolved.startsWith("/") ? "" : "/"}${resolved}`;
}

const REGISTRY_URL = toFileUrl(path.join(REPO_ROOT, "src/lib/db/adapters/adapterShutdownRegistry.js"));
const SQLJS_URL = toFileUrl(path.join(REPO_ROOT, "src/lib/db/adapters/sqljsAdapter.js"));

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-shutdown-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("child did not exit in time"));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child never became ready")), 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("adapterShutdownRegistry SIGTERM/SIGINT (L10)", () => {
  it("runs closers synchronously on SIGTERM and still exits by signal", async () => {
    const marker = path.join(tmpDir, "flushed");
    const childPath = path.join(tmpDir, "child-registry.mjs");
    fs.writeFileSync(
      childPath,
      `import { registerAdapterCloser } from ${JSON.stringify(REGISTRY_URL)};
import fs from "node:fs";
registerAdapterCloser(() => { fs.writeFileSync(${JSON.stringify(marker)}, "flushed"); });
process.stdout.write("READY\\n");
// Keep the loop alive like a real server would: signal listeners are unref'd,
// and an idle loop exits (unsettled top-level await → code 13) before SIGTERM lands.
setInterval(() => {}, 1000);
await new Promise(() => {});`
    );
    const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = waitForExit(child);
    await waitForReady(child);
    child.kill("SIGTERM");
    // A second SIGTERM must still terminate (handlers removed after first run).
    await new Promise((r) => setTimeout(r, 200));
    try { child.kill("SIGTERM"); } catch {}
    const { code, signal } = await exited;
    expect(fs.existsSync(marker)).toBe(true);
    expect(signal === "SIGTERM" || code === 143).toBe(true);
  });
});

describe("sql.js adapter SIGTERM persist (L10)", () => {
  it("persists unflushed rows written just before SIGTERM", async () => {
    const dbFile = path.join(tmpDir, "shutdown.sqlite");
    const childPath = path.join(tmpDir, "child-sqljs.mjs");
    fs.writeFileSync(
      childPath,
      `import { createSqlJsAdapter } from ${JSON.stringify(SQLJS_URL)};
const adapter = await createSqlJsAdapter(${JSON.stringify(dbFile)});
adapter.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v TEXT)");
adapter.run("INSERT INTO t (id, v) VALUES (?, ?)", ["row1", "hello"]);
process.stdout.write("READY\\n");
await new Promise(() => {});`
    );
    const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = waitForExit(child, 20000);
    await waitForReady(child);
    child.kill("SIGTERM");
    await exited;

    const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
    const reopened = await createSqlJsAdapter(dbFile);
    try {
      const row = reopened.get("SELECT v FROM t WHERE id = ?", ["row1"]);
      expect(row?.v).toBe("hello");
    } finally {
      reopened.close();
    }
  }, 30000);
});
