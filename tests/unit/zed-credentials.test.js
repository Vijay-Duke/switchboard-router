// Zed IDE credential discovery (keyring + kv_store system_id) — 7a436d20.
// child_process is mocked so the suite never touches a real secret store;
// settings.json / db.sqlite paths point at a temp XDG layout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { execCalls } = vi.hoisted(() => ({ execCalls: [] }));
const mockCli = vi.hoisted(() => ({
  // secret-tool / security / sqlite3 responses keyed by command
  responses: {},
}));

vi.mock("child_process", () => ({
  execFile: (cmd, args, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    execCalls.push([cmd, ...args]);
    const key = String(args[0]);
    const handler = mockCli.responses[`${cmd}:${key}`];
    if (handler) return handler(done);
    const generic = mockCli.responses[cmd];
    if (generic) return generic(done, args);
    const err = new Error("command not found");
    err.code = "ENOENT";
    return done(err);
  },
}));

import {
  ZED_DEFAULT_CREDENTIALS_URL,
  getZedGlobalDbPaths,
  readZedSystemId,
  readZedIdeCredentials,
  resolveZedCredentialsUrl,
} from "../../src/lib/oauth/zedCredentials.js";

const SECRET_TOOL_SEARCH_OUTPUT = [
  "attribute.url = https://zed.dev",
  "attribute.username = 123456",
  "[/60]",
  "label = zed-github-account",
  "secret = ide-secret-token",
].join("\n");

let tempRoot;
const savedEnv = {};

beforeEach(() => {
  execCalls.length = 0;
  mockCli.responses = {};
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zed-creds-"));
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, "config");
  process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
  fs.mkdirSync(path.join(tempRoot, "config", "zed"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveZedCredentialsUrl", () => {
  it("defaults to https://zed.dev when no settings.json exists", async () => {
    expect(await resolveZedCredentialsUrl()).toBe(ZED_DEFAULT_CREDENTIALS_URL);
  });

  it("honors credentials_url and strips the trailing slash", async () => {
    fs.writeFileSync(
      path.join(tempRoot, "config", "zed", "settings.json"),
      JSON.stringify({ credentials_url: "https://zed.example.com/" }),
    );
    expect(await resolveZedCredentialsUrl()).toBe("https://zed.example.com");
  });

  it("falls back to server_url when credentials_url is absent", async () => {
    fs.writeFileSync(
      path.join(tempRoot, "config", "zed", "settings.json"),
      JSON.stringify({ server_url: "https://zed.stg.dev" }),
    );
    expect(await resolveZedCredentialsUrl()).toBe("https://zed.stg.dev");
  });
});

describe("getZedGlobalDbPaths", () => {
  it("covers the release channels under XDG_DATA_HOME", () => {
    const paths = getZedGlobalDbPaths();
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(
      path.join(tempRoot, "data", "zed", "db", "0-global", "db.sqlite"),
    );
  });
});

describe("readZedSystemId", () => {
  it("returns null when no db exists", async () => {
    expect(await readZedSystemId()).toBeNull();
  });

  it("reads system_id from the first readable kv_store via sqlite3 fallback", async () => {
    const dbPath = path.join(tempRoot, "data", "zed", "db", "0-global", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite-placeholder");
    mockCli.responses["sqlite3"] = (done, args) => {
      const sql = String(args[1] || "");
      if (sql.includes("system_id")) return done(null, { stdout: "sys-from-ide\n" });
      return done(null, { stdout: "" });
    };
    expect(await readZedSystemId()).toBe("sys-from-ide");
  });

  it("survives a failing sqlite3 CLI", async () => {
    const dbPath = path.join(tempRoot, "data", "zed", "db", "0-global", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite-placeholder");
    mockCli.responses["sqlite3"] = (done) => done(new Error("locked"));
    expect(await readZedSystemId()).toBeNull();
  });
});

describe("readZedIdeCredentials (linux keyring)", () => {
  it("finds the zed-github-account entry and threads system_id", async () => {
    const dbPath = path.join(tempRoot, "data", "zed", "db", "0-global", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite-placeholder");
    mockCli.responses["secret-tool:search"] = (done) =>
      done(null, { stdout: SECRET_TOOL_SEARCH_OUTPUT, stderr: "" });
    mockCli.responses["sqlite3"] = (done, args) =>
      String(args[1] || "").includes("system_id")
        ? done(null, { stdout: "sys-ide-1" })
        : done(null, { stdout: "" });

    const result = await readZedIdeCredentials();
    expect(result.found).toBe(true);
    expect(result.userId).toBe("123456");
    expect(result.accessToken).toBe("ide-secret-token");
    expect(result.systemId).toBe("sys-ide-1");
    expect(result.credentialsUrl).toBe("https://zed.dev");
  });

  it("reports a helpful error when secret-tool is missing", async () => {
    const result = await readZedIdeCredentials();
    expect(result.found).toBe(false);
    expect(result.error).toMatch(/secret-tool not found/);
  });

  it("mints a fresh systemId when the kv_store is unavailable", async () => {
    mockCli.responses["secret-tool:search"] = (done) =>
      done(null, { stdout: SECRET_TOOL_SEARCH_OUTPUT, stderr: "" });
    const result = await readZedIdeCredentials();
    expect(result.found).toBe(true);
    expect(result.systemId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
