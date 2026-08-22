import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SUPPORTED_TARGETS = [
  "darwin/arm64",
  "darwin/x64",
  "linux/arm64",
  "linux/x64",
  "win32/arm64",
  "win32/x64",
];

// Usage: node scripts/build-claude-tls-helper.mjs [all|platform/arch ...]
// With no arguments, only the current platform/architecture is built.
const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length === 0
  ? [`${process.platform}/${process.arch}`]
  : requestedTargets.includes("all")
    ? SUPPORTED_TARGETS
    : requestedTargets;

for (const target of [...new Set(targets)]) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`Invalid target ${target}; expected one of ${SUPPORTED_TARGETS.join(", ")} or all`);
  }
  const [platform, arch] = target.split("/");
  const goos = platform === "win32" ? "windows" : platform;
  const goarch = arch === "x64" ? "amd64" : arch;
  const source = path.resolve("open-sse/identity/tls/native");
  const outputDir = path.resolve("open-sse/identity/tls/bin", platform, arch);
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, platform === "win32" ? "switchboard-claude-tls.exe" : "switchboard-claude-tls");
  const result = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
