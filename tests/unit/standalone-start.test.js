// `output: "standalone"` emits server.js but not custom-server.js. Without the
// copy step, `npm run start:standalone` dies with MODULE_NOT_FOUND — and that is
// the ONLY root command that can serve a wildcard bind, because it is the only
// one that derives the peer IP from the TCP socket.
//
// These tests run the real scripts as processes against a synthetic standalone
// tree, so the entrypoint is resolved AND started, not merely copied.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function run(script, distDir, extraArgs = []) {
  return spawnSync("node", [script, ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env, NEXT_DIST_DIR: distDir },
    encoding: "utf8",
  });
}

/** A stand-in for the Next standalone server: custom-server.js requires it. */
function fakeStandalone(dist, nested) {
  const dir = nested ? path.join(dist, "standalone", "switchboard") : path.join(dist, "standalone");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "server.js"),
    'console.log("STARTED trust=" + process.env.SWITCHBOARD_TRUST_REAL_IP + " host=" + process.env.HOSTNAME);\n'
  );
  return dir;
}

describe("standalone start contract", () => {
  let dist;

  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "sb-dist-"));
  });

  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("every build script chains the custom-server copy", () => {
    // A `postbuild` lifecycle hook would silently no-op under `ignore-scripts=true`.
    for (const script of ["build", "build:bun"]) {
      expect(pkg.scripts[script], script).toContain("copy-custom-server.mjs");
    }
  });

  it("start scripts resolve the entrypoint instead of hardcoding a path", () => {
    for (const script of ["start:standalone", "start:bun"]) {
      expect(pkg.scripts[script], script).toContain("start-standalone.mjs");
      expect(pkg.scripts[script], script).not.toContain(".next/standalone/custom-server.js");
    }
  });

  it.each([
    ["flat layout", false],
    ["nested layout (workspace tracing root)", true],
  ])("copies then actually starts the wrapper — %s", (_name, nested) => {
    const dir = fakeStandalone(dist, nested);

    const copy = run("scripts/copy-custom-server.mjs", dist);
    expect(copy.status, copy.stderr).toBe(0);
    // custom-server.js does require("./server.js") — it must land beside it.
    expect(fs.existsSync(path.join(dir, "custom-server.js"))).toBe(true);

    const start = run("scripts/start-standalone.mjs", dist);
    expect(start.status, start.stderr).toBe(0);
    expect(start.stdout).toContain("STARTED");
    // The wrapper is what makes locality trustworthy; prove it ran, not bare server.js.
    expect(start.stdout).toContain("trust=1");
    // And that the loopback bind default reached the child.
    expect(start.stdout).toContain("host=127.0.0.1");
  });

  it("fails the build when standalone output is absent", () => {
    // Exiting 0 here would ship a green build with an unstartable release.
    const copy = run("scripts/copy-custom-server.mjs", dist);
    expect(copy.status).toBe(1);
    expect(copy.stderr).toContain("no standalone server.js");
  });

  it("fails to start when the wrapper was never copied", () => {
    fakeStandalone(dist, false); // server.js only
    const start = run("scripts/start-standalone.mjs", dist);
    expect(start.status).toBe(1);
    expect(start.stderr).toContain("run `npm run build` first");
  });

  it("an explicit HOSTNAME still wins over the loopback default", () => {
    fakeStandalone(dist, false);
    execFileSync("node", ["scripts/copy-custom-server.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, NEXT_DIST_DIR: dist },
    });

    const start = spawnSync("node", ["scripts/start-standalone.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, NEXT_DIST_DIR: dist, HOSTNAME: "0.0.0.0" },
      encoding: "utf8",
    });

    expect(start.stdout).toContain("host=0.0.0.0");
  });

  it("the wrapper sets the trust flag the guard requires", () => {
    const src = fs.readFileSync(path.join(repoRoot, "custom-server.js"), "utf8");
    expect(src).toContain("SWITCHBOARD_TRUST_REAL_IP");
    expect(src).toContain('require("./server.js")');
  });
});
