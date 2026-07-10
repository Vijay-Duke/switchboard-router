// The workflows run a hand-maintained subset, not the full suite. That list has
// silently drifted twice, letting a security-boundary test exist while neither
// CI nor release ran it. These files guard an invariant — pin them.
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
  "unit/cli-disable-mitm.test.js", // crash-loop recovery writes the live store
  "unit/oauth-cursor-auto-import.test.js", // optional-dependency fallback
  "unit/ci-gate.test.js", // this list itself
];

describe.each([
  [".github/workflows/ci.yml"],
  [".github/workflows/release.yml"],
])("%s runs every invariant test", (workflow) => {
  const yaml = fs.readFileSync(path.join(repoRoot, workflow), "utf8");

  it.each(GATED)("gates %s", (testFile) => {
    expect(yaml).toContain(testFile);
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
