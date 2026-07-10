// scripts/launch.mjs replaces `HOSTNAME=${HOSTNAME:-127.0.0.1} <cmd>`, which is
// not valid cmd.exe syntax. It must default the bind, forward arguments verbatim,
// and propagate the child's exit code — without a shell on any platform.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand, withBindHostname } from "../../scripts/launch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let probe;

// Echoes argv and HOSTNAME, exits with the code it is told.
const PROBE = `
console.log("HOSTNAME=" + process.env.HOSTNAME);
console.log("ARGV=" + JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.EXIT_WITH || 0));
`;

function launch(args, env = {}) {
  return spawnSync("node", ["scripts/launch.mjs", "node", probe, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOSTNAME: "", ...env },
    encoding: "utf8",
  });
}

beforeAll(() => {
  probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-launch-")), "probe.cjs");
  fs.writeFileSync(probe, PROBE);
});

afterAll(() => {
  fs.rmSync(path.dirname(probe), { recursive: true, force: true });
});

describe("scripts/launch.mjs", () => {
  it("defaults HOSTNAME to loopback so the locality guard can trust the bind", () => {
    expect(launch([]).stdout).toContain("HOSTNAME=127.0.0.1");
  });

  it("lets an explicit HOSTNAME win", () => {
    expect(launch([], { HOSTNAME: "0.0.0.0" }).stdout).toContain("HOSTNAME=0.0.0.0");
  });

  it("propagates the child exit code", () => {
    expect(launch([], { EXIT_WITH: "7" }).status).toBe(7);
  });

  it.each([
    ["posix metacharacters", ["a b", "process.exit(0)", "$(echo pwned)", "semi;colon", "quo'te", 'dou"ble', "*"]],
    // These are what cmd.exe would re-parse if the child were routed through it:
    // %VAR% expands, & and | chain commands, ^ escapes, <> redirect, ! delays.
    ["cmd.exe metacharacters", ["a&b", "%PATH%", "x^y", "(z)", "p|q", "r>s", "t<u", "v!w", "%OS%&calc"]],
  ])("forwards %s verbatim", (_name, args) => {
    const result = launch(args);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.match(/ARGV=(.*)/)[1])).toEqual(args);
  });

  it("reports a clear error for an unknown command", () => {
    const result = spawnSync("node", ["scripts/launch.mjs", "definitely-not-a-binary"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to start definitely-not-a-binary");
  });
});

// resolveCommand is what makes the Windows branch safe: it never yields a .cmd
// shim (which only cmd.exe can exec, and which re-parses its arguments).
describe("resolveCommand", () => {
  it("maps node to the running interpreter", () => {
    expect(resolveCommand("node")).toEqual({ file: process.execPath, prefixArgs: [] });
  });

  it("resolves an npm bin to a JS entrypoint run by node, on every platform", () => {
    const { file, prefixArgs } = resolveCommand("next");

    expect(file).toBe(process.execPath);
    expect(prefixArgs).toHaveLength(1);
    expect(prefixArgs[0].endsWith(".cmd")).toBe(false);
    expect(fs.existsSync(prefixArgs[0])).toBe(true);
  });

  it("falls back to a PATH lookup for non-npm executables", () => {
    // `bun` is not an npm package here; spawn() resolves it (and bun.exe) itself.
    expect(resolveCommand("bun")).toEqual({ file: "bun", prefixArgs: [] });
  });
});

describe("withBindHostname", () => {
  it("passes the resolved loopback bind to next dev", () => {
    expect(withBindHostname("next", ["dev", "--webpack", "--port", "20128"], "127.0.0.1"))
      .toEqual(["dev", "--webpack", "--port", "20128", "--hostname", "127.0.0.1"]);
  });

  it("passes the resolved bind through the Bun next wrapper", () => {
    expect(withBindHostname("bun", ["--bun", "next", "dev", "--webpack"], "127.0.0.1"))
      .toEqual(["--bun", "next", "dev", "--webpack", "--hostname", "127.0.0.1"]);
  });

  it("does not override an explicit Next hostname", () => {
    const args = ["dev", "--hostname", "0.0.0.0"];
    expect(withBindHostname("next", args, "127.0.0.1")).toEqual(args);
  });

  it("leaves unrelated commands untouched", () => {
    const args = ["probe.cjs", "value"];
    expect(withBindHostname("node", args, "127.0.0.1")).toEqual(args);
  });
});
