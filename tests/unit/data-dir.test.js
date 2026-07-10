// getDataDir() must not strand an existing ~/.9router install after the rename.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home;
const originalHome = process.env.HOME;

function populate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "machine-id"), "abc");
}

// The CLI's postinstall warms this up before the server ever runs.
function warmRuntimeCache(dir) {
  fs.mkdirSync(path.join(dir, "runtime", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "runtime", "package.json"), "{}");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
}

// os.homedir() reads $HOME on POSIX, so no module mocking is needed.
// The module computes `export const DATA_DIR` at import time → reset between cases.
async function loadGetDataDir() {
  vi.resetModules();
  const mod = await import("../../src/lib/dataDir.js");
  return mod.getDataDir;
}

describe.skipIf(process.platform === "win32")("getDataDir legacy fallback", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-datadir-"));
    process.env.HOME = home;
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("adopts a populated legacy directory when the new one is absent", async () => {
    populate(path.join(home, ".9router"));
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, ".9router"));
  });

  it("prefers the new directory once it holds data", async () => {
    populate(path.join(home, ".9router"));
    populate(path.join(home, ".switchboard"));
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, ".switchboard"));
  });

  it("uses the new directory on a fresh install", async () => {
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, ".switchboard"));
  });

  it("an empty legacy directory does not win", async () => {
    fs.mkdirSync(path.join(home, ".9router"), { recursive: true });
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, ".switchboard"));
  });

  it("explicit DATA_DIR always wins", async () => {
    populate(path.join(home, ".9router"));
    process.env.DATA_DIR = path.join(home, "explicit");
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, "explicit"));
    delete process.env.DATA_DIR;
  });

  it("the CLI runtime warm-up does not hide a legacy database", async () => {
    // npm postinstall runs ensureSqliteRuntime() → ~/.switchboard/runtime,
    // before the server has ever written state. The legacy DB must still win.
    populate(path.join(home, ".9router"));
    warmRuntimeCache(path.join(home, ".switchboard"));
    const getDataDir = await loadGetDataDir();
    expect(getDataDir()).toBe(path.join(home, ".9router"));
  });
});

describe.skipIf(process.platform === "win32")("server and CLI resolvers agree", () => {
  // A divergence means the CLI signs tokens with a secret the server never reads.
  const originalPlatform = process.platform;

  /** @type {Array<[string, (h: string) => void, () => void]>} */
  const cases = [
    ["legacy only", (h) => populate(path.join(h, ".9router")), () => {}],
    ["new only", (h) => populate(path.join(h, ".switchboard")), () => {}],
    ["both", (h) => { populate(path.join(h, ".9router")); populate(path.join(h, ".switchboard")); }, () => {}],
    ["fresh", () => {}, () => {}],
    ["legacy + runtime warm-up", (h) => { populate(path.join(h, ".9router")); warmRuntimeCache(path.join(h, ".switchboard")); }, () => {}],
    ["explicit DATA_DIR", (h) => {}, () => { process.env.DATA_DIR = path.join(home, "explicit"); }],
    // The server rejects a Unix DATA_DIR on Windows and falls back; the CLI must too,
    // or it would pin an invalid path and read its cli-secret from nowhere.
    ["win32 + unix DATA_DIR", (h) => populate(path.join(h, ".9router")), () => {
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.APPDATA = path.join(home, "AppData", "Roaming");
      process.env.DATA_DIR = "/var/lib/switchboard";
    }],
    ["win32 + no DATA_DIR", () => {}, () => {
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.APPDATA = path.join(home, "AppData", "Roaming");
    }],
    ["unwritable DATA_DIR falls back", (h) => populate(path.join(h, ".9router")), () => {
      const locked = path.join(home, "locked");
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o500); // mkdirSync of a child throws EACCES
      process.env.DATA_DIR = path.join(locked, "data");
    }],
  ];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-parity-"));
    process.env.HOME = home;
    delete process.env.DATA_DIR;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    process.env.HOME = originalHome;
    delete process.env.DATA_DIR;
    delete process.env.APPDATA;
    try { fs.chmodSync(path.join(home, "locked"), 0o700); } catch { /* not every case creates it */ }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(cases)("resolves identically: %s", async (_name, setup, env) => {
    setup(home);
    env();
    const serverGetDataDir = await loadGetDataDir();
    vi.resetModules();
    const { getDataDir: cliGetDataDir } = await import("../../cli/src/shared/dataDir.js");
    expect(cliGetDataDir()).toBe(serverGetDataDir());
  });
});
