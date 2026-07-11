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

/**
 * Next does not use the HOSTNAME environment variable as its socket bind for
 * `dev`/`start`; it must receive --hostname explicitly. Keep the environment
 * value too because the locality guard uses the same resolved bind contract.
 * @param {string} command
 * @param {string[]} args
 * @param {string} hostname
 */
export function withBindHostname(command, args, hostname) {
  const nextIndex = command === "next" ? -1 : command === "bun" ? args.indexOf("next") : -2;
  const subcommandIndex = nextIndex + 1;
  if (nextIndex < -1 || !["dev", "start"].includes(args[subcommandIndex])) return args;
  if (args.some((arg) => arg === "--hostname" || arg === "-H" || arg.startsWith("--hostname="))) return args;
  return [...args, "--hostname", hostname];
}

/**
 * Resolve the hostname that Next will bind to, including an explicit CLI flag.
 * The locality guard reads HOSTNAME because a normal `next start` process has
 * no socket-derived peer address available.
 * @param {string[]} args
 * @param {string} fallback
 */
export function resolveBindHostname(args, fallback) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--hostname" || arg === "-H") return args[i + 1] || fallback;
    if (arg.startsWith("--hostname=")) return arg.slice("--hostname=".length) || fallback;
  }
  return fallback;
}

/**
 * Drain a child's output even if the launcher's terminal disappears. Passing
 * stdio through with `inherit` gives the child the same dead pipe; a later log
 * can then raise EPIPE inside framework error handling and wedge the server.
 *
 * @param {NodeJS.ReadableStream} source
 * @param {NodeJS.WritableStream & { destroyed?: boolean }} destination
 */
export function forwardOutput(source, destination) {
  let writable = true;
  const stopWriting = () => { writable = false; };

  destination.on("error", stopWriting);
  source.on("data", (chunk) => {
    // Keep consuming source after the destination breaks so the child never
    // blocks on a full stdout/stderr pipe.
    if (!writable || destination.destroyed) return;
    try {
      destination.write(chunk);
    } catch {
      writable = false;
    }
  });
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: node scripts/launch.mjs <command> [args...]");
    process.exit(1);
  }

  const defaultHostname = process.env.HOSTNAME || "127.0.0.1";
  const env = { ...process.env, HOSTNAME: resolveBindHostname(args, defaultHostname) };
  const { file, prefixArgs } = resolveCommand(cmd);
  const bindArgs = withBindHostname(cmd, args, env.HOSTNAME);

  const child = spawn(file, [...prefixArgs, ...bindArgs], {
    stdio: ["inherit", "pipe", "pipe"],
    env,
    windowsHide: true,
  });
  forwardOutput(child.stdout, process.stdout);
  forwardOutput(child.stderr, process.stderr);
  child.on("error", (err) => {
    console.error(`[launch] failed to start ${cmd}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

// Importable for tests; only launches when run as a script.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
