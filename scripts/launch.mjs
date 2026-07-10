// Cross-platform replacement for `HOSTNAME=${HOSTNAME:-127.0.0.1} <cmd>`, which
// is not valid syntax under cmd.exe. Defaults the bind to loopback so the
// locality guard can trust it; an explicit HOSTNAME still wins.
//
// No shell is involved on ANY platform. Two things force that:
//   - `shell: true` concatenates the argv into a command string (Node DEP0190),
//     which corrupts POSIX metacharacters.
//   - Routing a .cmd shim through `cmd.exe /c` looks safer but is not: cmd.exe
//     re-parses %VAR%, &, |, ^, <, >, ! and parentheses out of the arguments
//     Node hands it.
// So resolve an npm bin to the JavaScript file it points at and exec that with
// `process.execPath`. Arguments then reach the child verbatim, everywhere.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * @param {string} name command as written in package.json scripts
 * @returns {{file: string, prefixArgs: string[]}} what to exec, and args to prepend
 */
export function resolveCommand(name) {
  if (name === "node") return { file: process.execPath, prefixArgs: [] };

  // Read the package's own `bin` map rather than the .bin shim, which is a
  // shell/batch wrapper on disk and not directly executable by spawn().
  try {
    const manifestPath = require.resolve(`${name}/package.json`);
    const manifest = require(manifestPath);
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
    if (bin) {
      return { file: process.execPath, prefixArgs: [path.join(path.dirname(manifestPath), bin)] };
    }
  } catch {
    // Not an installed npm package (e.g. `bun`) — fall through to PATH lookup.
  }

  // A real executable on PATH. spawn() without a shell resolves .exe on Windows.
  return { file: name, prefixArgs: [] };
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: node scripts/launch.mjs <command> [args...]");
    process.exit(1);
  }

  const env = { ...process.env, HOSTNAME: process.env.HOSTNAME || "127.0.0.1" };
  const { file, prefixArgs } = resolveCommand(cmd);

  const child = spawn(file, [...prefixArgs, ...args], { stdio: "inherit", env, windowsHide: true });
  child.on("error", (err) => {
    console.error(`[launch] failed to start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

// Importable for tests; only launches when run as a script.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
