import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildScript = path.join(repoRoot, "scripts", "build-claude-tls-helper.mjs");
const helperTargets = [
  "darwin/arm64",
  "darwin/x64",
  "linux/arm64",
  "linux/x64",
  "win32/arm64",
  "win32/x64",
];
const impitPackages = [
  "impit-darwin-arm64",
  "impit-darwin-x64",
  "impit-linux-arm64-gnu",
  "impit-linux-arm64-musl",
  "impit-linux-x64-gnu",
  "impit-linux-x64-musl",
  "impit-win32-arm64-msvc",
  "impit-win32-x64-msvc",
];

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runHelperBuild(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-helper-build-"));
  tempDirs.push(dir);
  const callsFile = path.join(dir, "calls.jsonl");
  const fakeGo = path.join(dir, "go");
  fs.writeFileSync(fakeGo, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.GO_CALLS, JSON.stringify({
  args: process.argv.slice(2),
  cgo: process.env.CGO_ENABLED,
  goos: process.env.GOOS,
  goarch: process.env.GOARCH,
}) + "\\n");
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [buildScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GO_CALLS: callsFile,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    },
  });
  const calls = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { result, calls };
}

function targetFromCall(call) {
  const output = call.args[call.args.indexOf("-o") + 1];
  const normalized = output.split(path.sep).join("/");
  const match = normalized.match(/\/bin\/(darwin|linux|win32)\/(arm64|x64)\/switchboard-claude-tls(?:\.exe)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

describe("Claude TLS helper target builds", () => {
  it("builds every explicitly requested target with static Go binaries", () => {
    const requested = ["darwin/x64", "linux/arm64", "win32/x64"];
    const { result, calls } = runHelperBuild(requested);

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map(targetFromCall)).toEqual(requested);
    expect(calls.every((call) => call.cgo === "0")).toBe(true);
    expect(calls.map(({ goos, goarch }) => `${goos}/${goarch}`)).toEqual([
      "darwin/amd64",
      "linux/arm64",
      "windows/amd64",
    ]);
  });

  it("expands all to the six supported CLI targets", () => {
    const { result, calls } = runHelperBuild(["all"]);

    expect(result.status, result.stderr).toBe(0);
    expect(calls.map(targetFromCall)).toEqual(helperTargets);
  });
});

const helperTarPaths = [
  "app/open-sse/identity/tls/bin/darwin/arm64/switchboard-claude-tls",
  "app/open-sse/identity/tls/bin/darwin/x64/switchboard-claude-tls",
  "app/open-sse/identity/tls/bin/linux/arm64/switchboard-claude-tls",
  "app/open-sse/identity/tls/bin/linux/x64/switchboard-claude-tls",
  "app/open-sse/identity/tls/bin/win32/arm64/switchboard-claude-tls.exe",
  "app/open-sse/identity/tls/bin/win32/x64/switchboard-claude-tls.exe",
];

describe("universal CLI native packaging", () => {
  const cliPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "cli", "package.json"), "utf8"));
  const cliLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "cli", "package-lock.json"), "utf8"));
  const cliBuild = fs.readFileSync(path.join(repoRoot, "cli", "scripts", "build-cli.js"), "utf8");
  const snapshotSource = fs.readFileSync(path.join(repoRoot, "open-sse", "identity", "snapshot.js"), "utf8");
  const helperSource = fs.readFileSync(path.join(repoRoot, "open-sse", "identity", "tls", "claude-code.js"), "utf8");

  it("declares every impit native package as an exact optional dependency", () => {
    expect(Object.fromEntries(impitPackages.map((name) => [name, cliPackage.optionalDependencies[name]]))).toEqual(
      Object.fromEntries(impitPackages.map((name) => [name, "0.14.3"])),
    );
    expect(cliLock.packages[""].optionalDependencies).toMatchObject(
      Object.fromEntries(impitPackages.map((name) => [name, "0.14.3"])),
    );
    for (const name of impitPackages) {
      expect(cliLock.packages[`node_modules/${name}`]?.version, name).toBe("0.14.3");
    }
  });

  it("builds the five non-host helpers after the root build and copies the complete helper tree", () => {
    const rootBuild = cliBuild.indexOf('execSync("npm run build"');
    const crossBuild = cliBuild.indexOf("build-claude-tls-helper.mjs");
    expect(rootBuild).toBeGreaterThan(-1);
    expect(crossBuild).toBeGreaterThan(rootBuild);
    expect(cliBuild).toContain("CLAUDE_TLS_TARGETS");
    expect(cliBuild).toContain("process.platform");
    expect(cliBuild).toContain("process.arch");
    expect(cliBuild).toContain('"open-sse", "identity", "tls", "bin"');
  });

  it("contains the identity snapshot and all six prebuilt helpers without Go sources", () => {
    expect(fs.existsSync(path.join(repoRoot, "cli", "app", "open-sse", "identity", "snapshots", "versions.json"))).toBe(true);
    for (const helperPath of helperTarPaths) {
      expect(fs.existsSync(path.join(repoRoot, "cli", helperPath)), helperPath).toBe(true);
    }
    expect(fs.existsSync(path.join(repoRoot, "cli", "app", "open-sse", "identity", "tls", "native", "main.go"))).toBe(false);
  });

  it("resolves Claude identity assets from the standalone runtime directory", () => {
    expect(snapshotSource).toContain('path.join(process.cwd(), "open-sse", "identity", "snapshots", "versions.json")');
    expect(helperSource).toContain('path.join(process.cwd(), "open-sse", "identity", "tls", "bin"');
  });

  it("bundles generic impit without treating the host native package as the cross-platform source", () => {
    expect(cliBuild).toContain('ensureModuleInBundle("impit")');
    expect(cliBuild).not.toMatch(/name\.startsWith\(["']impit-/);
  });
});
