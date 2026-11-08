/**
 * `switchboard show [tools…]` — print a REDACTED summary of the Switchboard
 * settings each local CLI tool is currently using: base URL, masked API key
 * (or just "set" when the writer only exposes that), and models.
 *
 * Reads the same GET endpoints the dashboard uses, so no config parsing is
 * duplicated here. Read-only: contacts only the local management API, never
 * prints a full secret, and never lists stored API keys.
 */

const api = require("../api/client");
const { TOOLS, TOOL_IDS, resolveTools, findTool } = require("./connectTools");
const { __test__: { maskKey } } = require("./connect");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "localhost";

const HELP = `
Usage: switchboard show [tool…] [options]

Show the Switchboard settings each CLI tool on THIS machine is currently
using. Read-only: reads the gateway's config-status endpoints and prints a
redacted summary (base URL, masked API key, models). Never prints a full
secret.

  switchboard show                 # every supported tool
  switchboard show claude          # one tool
  switchboard show claude codex    # several (or: --tools claude,codex)
  switchboard show --json          # machine-readable (keys still masked)

Tools: ${TOOL_IDS.join(", ")}, all

Options:
  --tools <list>   Comma-separated tools (same as positional names)
  --json           Machine-readable output (API key still masked)
  --profiles       Also list Codex profiles (codex -p <name>)
  --host <host>    Management API host (default: ${DEFAULT_HOST})
  --port <port>    Management API port (default: ${DEFAULT_PORT})
  -h, --help       Show this help
`;

function parseArgs(argv) {
  const opts = { tools: [], host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--tools") opts.tools.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--json") opts.json = true;
    else if (a === "--profiles") opts.profiles = true;
    else if (a === "--host" || a === "-H") opts.host = next();
    else if (a === "--port" || a === "-p") {
      const port = Number(next());
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535");
      opts.port = port;
    } else if (a === "-h" || a === "--help") opts.help = true;
    else if (!a.startsWith("-")) opts.tools.push(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

// Server-controlled strings get printed — strip control characters so an
// attacker-controlled value cannot inject terminal escape sequences.
function stripControl(text) {
  return String(text ?? "").replace(/[\x00-\x1f\x7f]/g, "");
}

/** Normalize one tool's GET payload into a printable, key-safe record. */
function inspect(tool, data) {
  const record = { id: tool.id, name: tool.name, files: [] };
  try {
    const summary = tool.summarize(data) || {};
    record.installed = data?.installed !== false;
    record.configured = !!(summary.baseUrl || summary.apiKey || summary.apiKeySet || Object.keys(summary.models || {}).length);
    record.baseUrl = summary.baseUrl || null;
    record.apiKey = summary.apiKey ? maskKey(summary.apiKey) : null;
    if (summary.apiKeySet === true && !record.apiKey) record.apiKey = "(set — hidden by the tool)";
    record.models = summary.models || {};
    if (typeof summary.active === "boolean") record.active = summary.active;
    for (const [k, v] of Object.entries(summary.extra || summary)) {
      if (["baseUrl", "apiKey", "apiKeySet", "models", "active"].includes(k)) continue;
      if (v !== undefined && v !== null && v !== "" && typeof v !== "object") record.details = { ...(record.details || {}), [k]: String(v) };
    }
    const files = tool.files(data);
    if (files.length) record.files = files;
  } catch (err) {
    record.error = err.message;
  }
  return record;
}

function printRecord(r) {
  if (r.error) {
    console.log(`❌ ${r.name}: ${r.error}`);
    return;
  }
  if (r.installed === false) {
    console.log(`• ${r.name}: not installed`);
    return;
  }
  if (!r.configured) {
    console.log(`• ${r.name}: not configured for Switchboard${r.files[0] ? ` (${r.files[0]})` : ""}`);
    return;
  }
  const inactive = r.active === false ? "  \x1b[33m(Switchboard present but not the active provider)\x1b[0m" : "";
  console.log(`✅ ${r.name}${inactive}`);
  if (r.files.length) console.log(`   File:     ${r.files.join(", ")}`);
  console.log(`   Base URL: ${r.baseUrl || "(none)"}`);
  console.log(`   API key:  ${r.apiKey || "(none)"}`);
  const entries = Object.entries(r.models);
  if (!entries.length) console.log("   Models:   (none set — the tool's own default applies)");
  else {
    const width = Math.max(...entries.map(([k]) => k.length));
    console.log("   Models:");
    for (const [k, v] of entries) console.log(`     ${k.padEnd(width)}  ${v}`);
  }
  for (const [k, v] of Object.entries(r.details || {})) console.log(`   ${k}: ${v}`);
}

async function fetchTool(tool) {
  const res = await api.getCliToolSettings(tool.id);
  if (!res.success) throw new Error(res.error || `HTTP ${res.statusCode}`);
  return res.data;
}

async function fetchCodexProfiles() {
  const res = await api.listCodexProfiles();
  if (!res.success) throw new Error(res.error || `HTTP ${res.statusCode}`);
  return res.data?.profiles || [];
}

async function runShow(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  api.configure({ host: opts.host, port: opts.port });

  const tools = opts.tools.length ? resolveTools(opts.tools) : TOOLS;
  const records = [];
  for (const tool of tools) {
    try {
      records.push(inspect(tool, await fetchTool(tool)));
    } catch (err) {
      const unreachable = /network error/i.test(String(err.message || ""));
      if (unreachable) {
        console.error(`Cannot reach Switchboard at ${opts.host}:${opts.port} — is it running? Start it with: switchboard start`);
        return 1;
      }
      records.push({ id: tool.id, name: tool.name, files: [], error: stripControl(err.message) });
    }
  }

  if (opts.profiles) {
    try {
      const profiles = await fetchCodexProfiles();
      if (opts.json) console.log(JSON.stringify({ tools: records, codexProfiles: profiles }, null, 2));
      else {
        records.forEach((r, i) => { if (i) console.log(""); printRecord(r); });
        console.log("");
        if (!profiles.length) console.log("• codex profiles: none (create with: switchboard connect --codex-profile name=model)");
        else {
          console.log("• codex profiles:");
          for (const p of profiles) console.log(`     ${String(p.name).padEnd(16)} ${p.model || "(no model)"}   (codex -p ${p.name})`);
        }
      }
      return records.some((r) => r.error) ? 1 : 0;
    } catch (err) {
      console.log(`❌ codex profiles: ${stripControl(err.message)}`);
      return 1;
    }
  }

  if (opts.json) console.log(JSON.stringify(records, null, 2));
  else records.forEach((r, i) => { if (i) console.log(""); printRecord(r); });

  return records.some((r) => r.error) ? 1 : 0;
}

async function run(argv) {
  try {
    return await runShow(argv);
  } catch (err) {
    console.error(`❌ ${stripControl(err?.message || err)}`);
    return 1;
  }
}

module.exports = { run, HELP, __test__: { parseArgs, inspect, findTool, stripControl } };
