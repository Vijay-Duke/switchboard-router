const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "127.0.0.1";
const COMMANDS = new Set(["start", "status", "stop", "restart", "help", "version"]);

function isLoopbackHost(value) {
  const normalized = String(value).toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePort(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error("--port must be between 1 and 65535");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("--port must be between 1 and 65535");
  }
  return parsed;
}

function parseHost(value) {
  const host = String(value).trim();
  if (!host || /\s|\/|:\/\//.test(host)) {
    throw new Error("--host must be a hostname or IP address");
  }
  return host;
}

function parseCliArgs(argv, defaults = {}) {
  const args = [...argv];
  let command = "start";
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
    if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  }

  const parsed = {
    command,
    port: defaults.port || DEFAULT_PORT,
    host: defaults.host || DEFAULT_HOST,
    showLog: false,
    trayMode: false,
    skipUpdate: false,
    noBrowser: false,
    json: false,
    help: command === "help",
    version: command === "version",
    portProvided: false,
    hostProvided: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      parsed.port = parsePort(requireValue(args, i, arg));
      parsed.portProvided = true;
      i++;
    } else if (arg === "--host" || arg === "-H") {
      parsed.host = parseHost(requireValue(args, i, arg));
      parsed.hostProvided = true;
      i++;
    } else if (arg === "--no-browser" || arg === "-n") {
      parsed.noBrowser = true;
    } else if (arg === "--log" || arg === "-l") {
      parsed.showLog = true;
    } else if (arg === "--tray" || arg === "-t") {
      parsed.trayMode = true;
    } else if (arg === "--skip-update") {
      parsed.skipUpdate = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.json && command !== "status") {
    throw new Error("--json is only valid with the status command");
  }
  if (["status", "stop"].includes(command)) {
    const invalid = [parsed.showLog && "--log", parsed.trayMode && "--tray", parsed.skipUpdate && "--skip-update", parsed.noBrowser && "--no-browser"].filter(Boolean);
    if (invalid.length) throw new Error(`${invalid.join(", ")} is not valid with the ${command} command`);
  }
  return parsed;
}

function formatHelp({ version = "unknown", defaultPort = DEFAULT_PORT, defaultHost = DEFAULT_HOST } = {}) {
  return `Switchboard ${version}

Usage:
  switchboard [start] [options]   Start Switchboard (default)
  switchboard status [options]   Show server, version, PID, and ownership status
  switchboard stop [options]     Stop the owned Switchboard instance gracefully
  switchboard restart [options]  Gracefully stop, then start Switchboard

Lifecycle:
  In the terminal, press Ctrl+C to stop gracefully.
  In tray mode, choose Quit. You can always use "switchboard stop" if the icon is unavailable.
  A second start never kills an unrelated listener; use "switchboard status" to diagnose conflicts.

Options:
  -p, --port <port>   Server port (default: ${defaultPort})
  -H, --host <host>   Bind host (default: ${defaultHost})
  -l, --log           Stream server logs while retaining crash diagnostics
  -t, --tray          Run with the system-tray control surface
  -n, --no-browser    Compatibility flag; browsers open only when explicitly selected
      --skip-update   Skip the startup update check
      --json          Machine-readable output for "switchboard status"
  -h, --help          Show this help
  -v, --version       Show the version

Examples:
  switchboard
  switchboard --tray
  switchboard status
  switchboard restart --port ${defaultPort}
  switchboard stop
`;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  formatHelp,
  isLoopbackHost,
  parseCliArgs,
};
