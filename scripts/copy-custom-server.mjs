// `output: "standalone"` emits server.js but not our wrapper. custom-server.js
// does `require("./server.js")`, so it must sit beside it — and it is the only
// runtime that derives the peer IP from the TCP socket. Without this, every
// local-only /api/* route fails closed on a wildcard bind.
//
// Fails the build when standalone output is missing: a silent skip produces a
// green build and an unstartable release.
import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
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

const dist = process.env.NEXT_DIST_DIR || ".next";
const staticSource = join(dist, "static");
if (!existsSync(staticSource)) {
  console.error(`[build] no static assets under ${staticSource}.`);
  process.exit(1);
}

function replaceTree(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

copyFileSync(WRAPPER, join(dir, WRAPPER));
replaceTree(staticSource, join(dir, ".next", "static"));

const publicSource = join(process.cwd(), "public");
if (existsSync(publicSource)) {
  replaceTree(publicSource, join(dir, "public"));
}
console.log(`[build] copied ${WRAPPER} → ${dir}`);
