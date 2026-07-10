// Start the standalone build through custom-server.js, wherever the tracing root
// put it. Pass `--runtime bun` to exec it with bun instead of node.
import { spawn } from "node:child_process";
import { findWrapper, standaloneRoot } from "./standalone.mjs";

const runtimeFlag = process.argv.indexOf("--runtime");
const runtime = runtimeFlag === -1 ? process.execPath : process.argv[runtimeFlag + 1];

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
