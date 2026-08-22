// CI and release must either run the full suite or explicitly pin every
// security/packaging invariant below.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const GATED = [
  "unit/dashboard-guard.test.js", // request locality / DNS rebinding
  "unit/require-api-key-gate.test.js", // handler-level API-key authorization
  "unit/data-dir.test.js", // CLI/server secret-path parity
  "unit/standalone-start.test.js", // the only wildcard-bind-safe entrypoint
  "unit/launch.test.js", // argument forwarding, no shell
  "unit/responses-non-stream.test.js", // Responses client over Chat Completions upstream
  "unit/cli-disable-mitm.test.js", // crash-loop recovery writes the live store
  "unit/cli-model-catalogs.test.js", // external CLI config schemas and preservation
  "unit/cli-model-route-writes.test.js", // routes write the schemas the clients actually consume
  "unit/cli-tool-guides.test.js", // manual guides match supported client capabilities
  "unit/pi-multi-model-ui.test.js", // multi-model picker does not imply unsaved selections persist
  "unit/droid-managed-models.test.js", // Factory model ownership/default behavior
  "unit/oauth-cursor-auto-import.test.js", // optional-dependency fallback
  "unit/ci-gate.test.js", // this list itself
];

describe.each([
  [".github/workflows/ci.yml"],
  [".github/workflows/release.yml"],
])("%s runs every invariant test", (workflow) => {
  const yaml = fs.readFileSync(path.join(repoRoot, workflow), "utf8");
  const runsFullSuite = /npx vitest run --reporter=default/.test(yaml);

  it.each(GATED)("gates %s", (testFile) => {
    expect(runsFullSuite || yaml.includes(testFile)).toBe(true);
  });

  it("has no broken line continuations in the vitest invocation", () => {
    // A dropped trailing `\` silently truncates the list to one file.
    const lines = yaml.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!/^\s+unit\/.*\.test\.js/.test(line)) continue;
      const next = lines[i + 1] ?? "";
      const continues = /^\s+(unit\/|--reporter)/.test(next);
      if (continues) expect(line.trimEnd().endsWith("\\"), `${workflow}:${i + 1}`).toBe(true);
    }
  });
});

describe("release trigger invariants", () => {
  const release = fs.readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const docs = fs.readFileSync(path.join(repoRoot, ".github/workflows/gitbook-pages.yml"), "utf8");
  const docker = fs.readFileSync(path.join(repoRoot, ".github/workflows/docker-publish.yml"), "utf8");

  it("creates product releases only from v* tag pushes", () => {
    expect(release).toContain('      - "v*"');
    expect(release).not.toContain("workflow_dispatch:");
    expect(release).toContain("tag_name: ${{ needs.resolve-version.outputs.tag }}");
    expect(release).toContain("assert-release-version.mjs");
    expect(release).not.toContain("npm version");
  });

  it("keeps documentation deployment separate from product releases", () => {
    expect(docs).toContain('      - "gitbook/**"');
    expect(docs).toContain("workflow_dispatch:");
    expect(docs).not.toContain("action-gh-release");
  });

  it("allows Docker recovery builds only from an existing release tag", () => {
    expect(docker).toContain("release_tag:");
    expect(docker).toContain("ref: ${{ inputs.release_tag }}");
    expect(docker).toContain("Expected an immutable v* release tag");
    expect(docker).not.toContain("${{ inputs.tag }}");
  });
});

describe("Claude TLS helper build contracts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const cliBuild = fs.readFileSync(path.join(repoRoot, "cli/scripts/build-cli.js"), "utf8");
  const docker = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

  it("builds the helper before both root production builds", () => {
    expect(pkg.scripts.build).toMatch(/^npm run build:claude-tls && /);
    expect(pkg.scripts["build:bun"]).toMatch(/^npm run build:claude-tls && /);
  });

  it("lets the root build own the single CLI helper build", () => {
    expect(cliBuild).not.toContain('execSync("npm run build:claude-tls"');
    expect(cliBuild).toContain('execSync("npm run build"');
  });

  it("uses a unique temporary CLI build home outside generated-state cleanup", () => {
    expect(cliBuild).toContain('const os = require("os")');
    expect(cliBuild).toContain("fs.mkdtempSync(path.join(os.tmpdir(), \"switchboard-cli-build-\"))");
    expect(cliBuild).toContain("for (const generated of [cliAppDir, buildDistDir])");
    expect(cliBuild).not.toContain("[cliAppDir, buildHomeDir, buildDistDir]");
    expect(cliBuild).toContain('process.once("exit"');
    expect(cliBuild).toContain("fs.rmSync(buildHomeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })");
    expect(cliBuild).toContain("HOME: buildHomeDir");
    expect(cliBuild).toContain("USERPROFILE: buildHomeDir");
    expect(cliBuild).toContain('APPDATA: path.join(buildHomeDir, "AppData", "Roaming")');
    expect(cliBuild).toContain('LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local")');
    expect(cliBuild).toContain('NEXT_TRACING_ROOT_MODE: "workspace"');
  });

  it("installs Go wherever a clean production build runs", () => {
    expect(docker).toMatch(/apk --no-cache add[^\n]*\bgo\b/);
    expect(ci).toContain("actions/setup-go@v6");
    expect(ci).toContain("go-version: 1.25.x");
    expect(release).toContain("actions/setup-go@v6");
    expect(release).toContain("go-version: 1.25.x");
  });
});

describe("GitHub Actions runtime support", () => {
  const workflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/docker-publish.yml",
    ".github/workflows/gitbook-pages.yml",
  ].map((workflow) => fs.readFileSync(path.join(repoRoot, workflow), "utf8")).join("\n");

  it("does not use deprecated Node 20 action majors", () => {
    expect(workflows).not.toContain("actions/checkout@v4");
    expect(workflows).not.toContain("actions/setup-node@v4");
    expect(workflows).not.toContain("actions/upload-artifact@v4");
    expect(workflows).not.toContain("actions/download-artifact@v4");
    expect(workflows).not.toContain("actions/upload-pages-artifact@v3");
    expect(workflows).not.toContain("actions/deploy-pages@v4");
  });
});
