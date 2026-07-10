// Single source of truth for where `output: "standalone"` put the server, so the
// build-time copy and the start command can never disagree. The tracing root
// decides whether server.js lands at standalone/ or standalone/<pkg>/
// (NEXT_TRACING_ROOT_MODE=workspace), and hardcoding either one has already
// shipped a broken `start:standalone` once.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const WRAPPER = "custom-server.js";

export function standaloneRoot() {
  return join(process.env.NEXT_DIST_DIR || ".next", "standalone");
}

/** Directory holding server.js, or null when the build produced no standalone output. */
export function findServerDir(root = standaloneRoot()) {
  if (!existsSync(root)) return null;
  if (existsSync(join(root, "server.js"))) return root;
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    if (statSync(child).isDirectory() && existsSync(join(child, "server.js"))) return child;
  }
  return null;
}

/** Path to the wrapper that must be started, or null when it was never copied. */
export function findWrapper(root = standaloneRoot()) {
  const dir = findServerDir(root);
  if (!dir) return null;
  const wrapper = join(dir, WRAPPER);
  return existsSync(wrapper) ? wrapper : null;
}
