import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installerPath = path.join(repoRoot, "install.sh");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function runInstaller({ installNoop = false, staleCommand = false } = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-install-test-"));
  temporaryDirectories.push(temporaryDirectory);

  const binDirectory = path.join(temporaryDirectory, "bin");
  const globalPrefix = path.join(temporaryDirectory, "global");
  const globalBin = path.join(globalPrefix, "bin");
  const globalRoot = path.join(temporaryDirectory, "global", "lib", "node_modules");
  const packageDirectory = path.join(globalRoot, "switchboard-router");
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.mkdirSync(globalBin, { recursive: true });
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "switchboard-router",
    version: "0.6.1",
  }));

  writeExecutable(path.join(binDirectory, "node"), `#!/usr/bin/env bash
exec "$REAL_NODE" "$@"
`);
  writeExecutable(path.join(globalBin, "switchboard"), "#!/usr/bin/env bash\nexit 0\n");
  if (staleCommand) {
    writeExecutable(path.join(binDirectory, "switchboard"), "#!/usr/bin/env bash\nexit 0\n");
  }
  writeExecutable(path.join(binDirectory, "npm"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"

if [[ "$1" == "view" ]]; then
  printf '%s\\n' "$FAKE_LATEST_VERSION"
  exit 0
fi

if [[ "$1" == "root" && "$2" == "-g" ]]; then
  printf '%s\\n' "$FAKE_GLOBAL_ROOT"
  exit 0
fi

if [[ "$1" == "prefix" && "$2" == "-g" ]]; then
  printf '%s\\n' "$FAKE_GLOBAL_PREFIX"
  exit 0
fi

if [[ "$1" == "i" || "$1" == "install" ]]; then
  if [[ "\${FAKE_INSTALL_NOOP:-0}" != "1" && "$*" == *"switchboard-router@$FAKE_LATEST_VERSION"* ]]; then
    printf '{"name":"switchboard-router","version":"%s"}\\n' "$FAKE_LATEST_VERSION" > "$FAKE_GLOBAL_ROOT/switchboard-router/package.json"
  fi
  exit 0
fi

printf 'unexpected npm invocation: %s\\n' "$*" >&2
exit 64
`);

  return {
    packageJson: path.join(packageDirectory, "package.json"),
    result: spawnSync("bash", [installerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${globalBin}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        FAKE_GLOBAL_PREFIX: globalPrefix,
        FAKE_GLOBAL_ROOT: globalRoot,
        FAKE_INSTALL_NOOP: installNoop ? "1" : "0",
        FAKE_LATEST_VERSION: "0.6.5",
        FAKE_NPM_LOG: path.join(temporaryDirectory, "npm.log"),
      },
    }),
  };
}

describe("install.sh", () => {
  it("upgrades an existing install to the exact latest npm version", () => {
    const { packageJson, result } = runInstaller();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(packageJson, "utf8")).version).toBe("0.6.5");
    expect(result.stdout).toContain("Installed switchboard-router 0.6.5");
  });

  it("fails instead of claiming success when npm leaves the old version installed", () => {
    const { packageJson, result } = runInstaller({ installNoop: true });

    expect(result.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(packageJson, "utf8")).version).toBe("0.6.1");
    expect(result.stderr).toContain("expected 0.6.5, found 0.6.1");
    expect(result.stdout).not.toContain("Installed switchboard-router 0.6.5");
  });

  it("fails when the shell resolves switchboard from a different global prefix", () => {
    const { packageJson, result } = runInstaller({ staleCommand: true });

    expect(JSON.parse(fs.readFileSync(packageJson, "utf8")).version).toBe("0.6.5");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The switchboard command resolves to an older or different installation");
    expect(result.stdout).not.toContain("Installed switchboard-router 0.6.5");
  });
});
