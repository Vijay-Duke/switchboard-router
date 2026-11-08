// Resolve a writable data directory for lazy runtime installs: DATA_DIR first,
// then ~/.switchboard (legacy ~/.9router), then tmpdir. Some installs point
// DATA_DIR at root-owned paths (e.g. /var/lib) that the server process cannot
// write runtime installs into — those must fall through instead of failing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

function candidates() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    process.env.DATA_DIR,
    home && path.join(home, ".switchboard"),
    home && path.join(home, ".9router"), // pre-fork installs keep their runtime dir
    path.join(os.tmpdir(), "switchboard"),
  ].filter(Boolean);
}

export function getWritableDataDir() {
  if (cached) return cached;
  for (const base of candidates()) {
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.accessSync(base, fs.constants.W_OK);
      cached = base;
      return cached;
    } catch {
      // Not writable — try the next candidate.
    }
  }
  cached = process.cwd();
  return cached;
}
