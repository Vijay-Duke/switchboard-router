// Start the standalone build through custom-server.js, wherever the tracing root
// put it. Pass `--runtime bun` to exec it with bun instead of node.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findWrapper, standaloneRoot } from "./standalone.mjs";

export function resolveRuntime(argv = process.argv, execPath = process.execPath) {
  const runtimeFlag = argv.indexOf("--runtime");
  if (runtimeFlag === -1) return execPath;
  const runtime = argv[runtimeFlag + 1];
  if (!runtime || runtime.startsWith("--")) {
    throw new Error("usage: start-standalone.mjs [--runtime <bin>]");
  }
  return runtime;
}

export function main(argv = process.argv) {
  let runtime;
  try {
    runtime = resolveRuntime(argv);
  } catch (err) {
    console.error(`[start] ${err.message}`);
    process.exit(1);
  }

  const wrapper = findWrapper();
  if (!wrapper) {
    console.error(
      `[start] no custom-server.js under ${standaloneRoot()} — run \`npm run build\` first.`
    );
    process.exit(1);
  }

  // Loopback default so the locality guard can trust the bind; explicit wins.
  const env = { ...process.env, HOSTNAME: process.env.HOSTNAME || "127.0.0.1" };

  const child = spawn(runtime, [wrapper], { stdio: "inherit", env });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
