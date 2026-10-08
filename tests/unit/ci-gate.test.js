// CI and release must either run the full suite or explicitly pin every
// security/packaging invariant below.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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

// Follow actual job calls rather than scanning comments or unrelated YAML text.
// Only unconditionally required jobs/steps in the tests directory establish a gate.
const required = item => item?.if === undefined && !item?.["continue-on-error"];
const localWorkflow = /^\.\/\.github\/workflows\/[\w.-]+\.ya?ml$/;
const PUBLISHERS = ["publish-npm", "github-release", "docker-build", "docker"];
const documents = Object.fromEntries(["ci", "release"].map(name => {
  const file = `.github/workflows/${name}.yml`;
  return [file, parseYaml(fs.readFileSync(path.join(repoRoot, file), "utf8"))];
}));

function logicalCommands(run) {
  const commands = [];
  let continued = "";
  for (const line of String(run).split(/\r?\n/)) {
    if (!continued && !line.trim()) continue;
    if (!continued && /^\s*(unit\/.*\.test\.js|--reporter)/.test(line)) {
      throw new Error("Broken vitest line continuation");
    }
    const combined = continued + line.trim();
    if (combined.endsWith("\\")) continued = combined.slice(0, -1) + " ";
    else { commands.push(combined); continued = ""; }
  }
  if (continued) throw new Error("Unfinished vitest line continuation");
  return commands;
}

function coversTest(runs, testFile) {
  return runs.some(run => {
    const commands = logicalCommands(run);
    // Mixed shell scripts can reset exit status or disable fail-fast behavior.
    if (commands.length !== 1) return false;
    return commands.some(command => {
    const match = command.match(/^npx\s+vitest\s+run(?:\s+(.*))?$/);
    if (!match || /[;&|]/.test(command)) return false;
    const args = (match[1] || "").split(/\s+/).filter(Boolean);
    // An invocation with a filter must name the invariant explicitly. Unknown
    // flags (e.g. --exclude) cannot prove that the complete suite is included.
    const filters = args.filter(arg => arg !== "--reporter=default");
    return !filters.some(arg => arg.startsWith("-")) && (filters.length === 0 || filters.includes(testFile));
    });
  });
}

function workflowRuns(file, docs, visiting = [], selectRun = (_step, directory) => directory === "tests") {
  if (visiting.includes(file)) throw new Error("Reusable workflow cycle");
  const workflow = docs[file];
  if (!workflow?.jobs) throw new Error(`Missing workflow: ${file}`);
  const prerequisitesRequired = (id, ancestors = []) => {
    const job = workflow.jobs[id];
    if (!job || !required(job) || ancestors.includes(id)) return false;
    return [job.needs || []].flat().every(dependency =>
      prerequisitesRequired(dependency, [...ancestors, id]));
  };
  return Object.fromEntries(Object.entries(workflow.jobs).map(([id, job]) => {
    if (!prerequisitesRequired(id)) return [id, []];
    if (job.uses) {
      if (!localWorkflow.test(job.uses)) return [id, []];
      const calledFile = job.uses.slice(2);
      if (!Object.hasOwn(docs[calledFile]?.on || {}, "workflow_call")) {
        throw new Error(`Not callable with workflow_call: ${calledFile}`);
      }
      return [id, Object.values(workflowRuns(calledFile, docs, [...visiting, file], selectRun)).flat()];
    }
    return [id, (job.steps || []).filter(step => {
      const directory = step["working-directory"] || job.defaults?.run?.["working-directory"]
        || workflow.defaults?.run?.["working-directory"] || "";
      return required(step) && step.run && selectRun(step, directory.replace(/^\.\//, ""), job);
    }).map(step => step.run)];
  }));
}

function publicationRuns(file, publisher, docs, runs = workflowRuns(file, docs)) {
  const jobs = docs[file]?.jobs || {};
  if (!jobs[publisher] || !required(jobs[publisher])) return [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return [];
    seen.add(id);
    const job = jobs[id];
    if (!job) throw new Error(`Missing gate dependency: ${id}`);
    if (!required(job)) return [];
    return [...(runs[id] || []), ...[job.needs || []].flat().flatMap(visit)];
  };
  return [jobs[publisher].needs || []].flat().flatMap(visit);
}

describe.each([
  [".github/workflows/ci.yml"],
  [".github/workflows/release.yml"],
])("%s runs every invariant test", workflow => {
  const runs = workflowRuns(workflow, documents);
  it.each(GATED)("gates %s", testFile => {
    expect(coversTest(Object.values(runs).flat(), testFile)).toBe(true);
  });
  it("has no broken line continuations in required test steps", () => {
    for (const run of Object.values(runs).flat()) expect(() => logicalCommands(run)).not.toThrow();
  });
});

describe("publication waits for actual reusable CI tests", () => {
  it.each(PUBLISHERS)("%s waits for every invariant", publisher => {
    const runs = publicationRuns(".github/workflows/release.yml", publisher, documents);
    for (const testFile of GATED) expect(coversTest(runs, testFile), `${publisher}: ${testFile}`).toBe(true);
  });

  const fixture = () => structuredClone({
    ".github/workflows/ci.yml": {
      on: { workflow_call: null },
      jobs: { tests: { steps: [{ "working-directory": "tests", run: "npx vitest run --reporter=default" }] } },
    },
    ".github/workflows/release.yml": {
      jobs: {
        test: { uses: "./.github/workflows/ci.yml" },
        build: { needs: "test", steps: [] },
        publish: { needs: "build", steps: [] },
      },
    },
  });
  const gated = docs => coversTest(publicationRuns(".github/workflows/release.yml", "publish", docs), GATED[0]);

  it("accepts an actual same-commit workflow_call through a transitive gate", () => {
    expect(gated(fixture())).toBe(true);
  });
  it("does not count a called CI test job whose prerequisite is skipped", () => {
    const docs = fixture();
    docs[".github/workflows/ci.yml"].jobs.setup = { if: false, steps: [] };
    docs[".github/workflows/ci.yml"].jobs.tests.needs = "setup";
    expect(gated(docs)).toBe(false);
  });
  it("accepts the trailing newline in a normal YAML block scalar", () => {
    const docs = fixture();
    docs[".github/workflows/ci.yml"].jobs.tests.steps[0].run = parseYaml("run: |\n  npx vitest run --reporter=default\n").run;
    expect(gated(docs)).toBe(true);
  });
  it("rejects publication detached from the otherwise-present reusable test job", () => {
    const docs = fixture(); delete docs[".github/workflows/release.yml"].jobs.build.needs;
    expect(gated(docs)).toBe(false);
  });
  it("rejects publishing with always() after a failed dependency", () => {
    const docs = fixture(); docs[".github/workflows/release.yml"].jobs.publish.if = "${{ always() }}";
    expect(gated(docs)).toBe(false);
  });
  it("rejects an always() bridge that lets publication outlive failed tests", () => {
    const docs = fixture(); docs[".github/workflows/release.yml"].jobs.build.if = "${{ always() }}";
    expect(gated(docs)).toBe(false);
  });
  it("does not count a YAML boolean-false test condition", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.if = false;
    expect(gated(docs)).toBe(false);
  });
  it("rejects a workflow from an unverified branch or external repository", () => {
    const docs = fixture(); docs[".github/workflows/release.yml"].jobs.test.uses = "owner/repo/.github/workflows/ci.yml@main";
    expect(gated(docs)).toBe(false);
  });
  it("rejects a local workflow that does not declare workflow_call", () => {
    const docs = fixture(); delete docs[".github/workflows/ci.yml"].on.workflow_call;
    expect(() => gated(docs)).toThrow(/workflow_call/);
  });
  it("rejects a reusable workflow cycle", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests = { uses: "./.github/workflows/ci.yml" };
    expect(() => gated(docs)).toThrow(/cycle/);
  });
  it.each(["if", "continue-on-error"])("does not count optional test jobs (%s)", flag => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests[flag] = flag === "if" ? "${{ false }}" : true;
    expect(gated(docs)).toBe(false);
  });
  it.each(["if", "continue-on-error"])("does not count optional test steps (%s)", flag => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.steps[0][flag] = flag === "if" ? "${{ false }}" : true;
    expect(gated(docs)).toBe(false);
  });
  it("does not count a vitest invocation in a different directory", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.steps[0]["working-directory"] = "gitbook";
    expect(gated(docs)).toBe(false);
  });
  it.each([
    "npx vitest run unit/another.test.js --reporter=default",
    "# npx vitest run --reporter=default",
    "echo npx vitest run --reporter=default",
    "npx vitest run --reporter=default || true",
    "set +e\nnpx vitest run --reporter=default",
    "npx vitest run --reporter=default --exclude unit/dashboard-guard.test.js",
  ])("does not mistake a bypass or filtered command for the full suite: %s", command => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.steps[0].run = command;
    expect(gated(docs)).toBe(false);
  });
  it("accepts a required explicitly named invariant", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.steps[0].run = `npx vitest run ${GATED[0]} --reporter=default`;
    expect(gated(docs)).toBe(true);
  });
  it("rejects a missing continuation in the actual run script", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs.tests.steps[0].run = `npx vitest run ${GATED[0]}\nunit/data-dir.test.js --reporter=default`;
    expect(() => gated(docs)).toThrow(/continuation/);
  });
});

const NATIVE_GO_DIR = "open-sse/identity/tls/native";
const NATIVE_GO_COMMAND = "go test ./...";

function nativeGoRun(step, directory, job) {
  if (directory !== NATIVE_GO_DIR || logicalCommands(step.run).join("\n") !== NATIVE_GO_COMMAND) return false;
  const index = job.steps.indexOf(step);
  const setup = job.steps.findIndex(candidate => required(candidate)
    && candidate.uses === "actions/setup-go@v6" && candidate.with?.["go-version"] === "1.25.x");
  const pack = job.steps.findIndex(candidate => required(candidate)
    && candidate["working-directory"] === "cli" && candidate.run === "npm run pack:cli");
  return setup >= 0 && setup < index && pack > index;
}

describe("native Claude TLS regressions gate publication", () => {
  const nativeGated = (docs, publisher = "publish-npm") => {
    const file = ".github/workflows/release.yml";
    const runs = workflowRuns(file, docs, [], nativeGoRun);
    return publicationRuns(file, publisher, docs, runs).includes(NATIVE_GO_COMMAND);
  };

  it.each(PUBLISHERS)("%s waits for required native Go tests before CLI packaging", publisher => {
    expect(nativeGated(documents, publisher)).toBe(true);
  });

  const fixture = () => {
    const docs = structuredClone(documents);
    docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps = [
      { uses: "actions/setup-go@v6", with: { "go-version": "1.25.x" } },
      { "working-directory": NATIVE_GO_DIR, run: NATIVE_GO_COMMAND },
      { "working-directory": "cli", run: "npm run pack:cli" },
    ];
    return docs;
  };
  it("accepts an unconditional native regression step reached through called CI", () => {
    expect(nativeGated(fixture())).toBe(true);
  });
  it("rejects a removed native regression step", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps.splice(1, 1);
    expect(nativeGated(docs)).toBe(false);
  });
  it.each(["if", "continue-on-error"])("rejects an optional native test step (%s)", flag => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps[1][flag] = flag === "if" ? false : true;
    expect(nativeGated(docs)).toBe(false);
  });
  it("rejects the native command in a different directory", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps[1]["working-directory"] = "open-sse/identity/tls";
    expect(nativeGated(docs)).toBe(false);
  });
  it("rejects swallowed native regression failures", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps[1].run += " || true";
    expect(nativeGated(docs)).toBe(false);
  });
  it("requires native regressions before packaging", () => {
    const docs = fixture(); const steps = docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps;
    [steps[1], steps[2]] = [steps[2], steps[1]];
    expect(nativeGated(docs)).toBe(false);
  });
  it("requires the Go toolchain before native regressions", () => {
    const docs = fixture(); docs[".github/workflows/ci.yml"].jobs["cli-pack"].steps.shift();
    expect(nativeGated(docs)).toBe(false);
  });
  it("rejects publication detached from the native regression gate", () => {
    const docs = fixture(); docs[".github/workflows/release.yml"].jobs["publish-npm"].needs = ["resolve-version"];
    expect(nativeGated(docs)).toBe(false);
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
