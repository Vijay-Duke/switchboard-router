// `output: "standalone"` emits server.js but not our wrapper. custom-server.js
// does `require("./server.js")`, so it must sit beside it — and it is the only
// runtime that derives the peer IP from the TCP socket. Without this, every
// local-only /api/* route fails closed on a wildcard bind.
//
// Fails the build when standalone output is missing: a silent skip produces a
// green build and an unstartable release.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { findServerDir, standaloneRoot, WRAPPER } from "./standalone.mjs";

const root = standaloneRoot();
const dir = findServerDir(root);

if (!dir) {
  console.error(
    `[build] no standalone server.js under ${root}.\n` +
    `        next.config.mjs must keep output: "standalone" — ${WRAPPER} is the only ` +
    `entrypoint that can serve a wildcard bind.`
  );
  process.exit(1);
}

copyFileSync(WRAPPER, join(dir, WRAPPER));
console.log(`[build] copied ${WRAPPER} → ${dir}`);
