/** Configure local tool files using a newly minted gateway key. */

const os = require("os");
const api = require("../api/client");
const localConfig = require("./localConfig");
const { authenticate, normalizeServerUrl } = require("./remoteConnection");
const { TOOLS, TOOL_IDS, CLAUDE_TIERS, resolveTools } = require("./connectTools");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "localhost";

const HELP = `
Usage: switchboard connect [server-url] [options]

Configure tools on this machine for a local or remote Switchboard gateway.
A remote connection signs in with your dashboard API key and mints a fresh
client key. Configuration is written locally; no local server is started.

  switchboard connect https://gateway.example --tools claude,codex
  switchboard connect                          # interactive: pick tools + models
  switchboard connect --tools claude,codex     # non-interactive tool selection
  switchboard connect --tools all --model cc/claude-sonnet-5
  switchboard connect --reset --tools claude   # remove Switchboard settings

Options:
  --api-key <key>        Dashboard sign-in key (or SWITCHBOARD_CONNECT_KEY;
                         prompted in a terminal). Tools receive a NEW key.
  --save                Save this server's dashboard session with mode 600
                         in the Switchboard data directory (no API key saved)
  --tools <list>         Comma-separated tools (prompted in a terminal when
                         omitted; default: claude). Supported:
                         ${TOOL_IDS.join(", ")}, all
  --model <id>           Model written into every selected tool that needs one
                         (prompted per tool in a terminal when omitted; tools
                         left without a model are skipped)
  --opus|--sonnet|--fable|--haiku <model>
                         Override one Claude Code tier (default: tiers are left
                         unset and Claude Code picks its own)
  --codex-profile <name=model>
                         Also write a Codex profile (codex -p <name>); the
                         profile only picks the model. Repeatable.
  --key-name <name>      Name for the freshly minted API key
                         (default: cli-<hostname>)
  --base-url <url>       Base URL written into the tool configs (default:
                         selected server, or http://localhost:<port>)
  --host <host>          Local management API host (default: ${DEFAULT_HOST})
  --port <port>          Management API port (default: ${DEFAULT_PORT})
  --print-env            Print OpenAI-compatible env vars for other CLIs
                         (includes the freshly minted key — copy it somewhere
                         safe; it is not shown again)
  --list-tools           List the supported tools and exit
  --reset                Remove Switchboard settings from the selected tools
  -h, --help             Show this help

Connections mint a NEW API key (one-time secret). Remove unused ones in the
dashboard or the API Keys terminal menu.

Undo:  switchboard connect --reset --tools <same list>
`;

// Enquirer rejects with an empty value on Ctrl+C / Esc.
class Cancelled extends Error {}
const runPrompt = (p) => p.run().catch((err) => { throw err || new Cancelled("Cancelled"); });

function parseArgs(argv) {
  const opts = {
    authKey: process.env.SWITCHBOARD_CONNECT_KEY || null,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    tools: null,
    keyName: `cli-${os.hostname()}`.slice(0, 64),
    model: null,
    models: {}, // claude tier flags: { opus, sonnet, fable, haiku }
    codexProfiles: [],
    printEnv: false,
    reset: false,
    listTools: false,
  };
  const tierFlags = new Set(CLAUDE_TIERS.map((t) => `--${t.flag}`));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === "--api-key") opts.authKey = next();
    else if (a === "--save") opts.save = true;
    else if (a === "--tools") opts.tools = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--model" || a === "-m") opts.model = next();
    else if (a === "--key-name") opts.keyName = next();
    else if (a === "--base-url") {
      const v = next();
      try {
        const u = new URL(v);
        if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error();
        opts.baseUrl = u.origin;
      } catch {
        throw new Error("--base-url must be a valid HTTP(S) URL");
      }
    }
    else if (a === "--host" || a === "-H") opts.host = next();
    else if (a === "--port" || a === "-p") {
      const port = Number(next());
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535");
      opts.port = port;
    } else if (a === "--codex-profile") opts.codexProfiles.push(next());
    else if (a === "--print-env") opts.printEnv = true;
    else if (a === "--reset") opts.reset = true;
    else if (a === "--list-tools") opts.listTools = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--") && tierFlags.has(a)) opts.models[a.slice(2)] = next();
    else if (!a.startsWith("-") && !opts.url) opts.url = normalizeServerUrl(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(opts.host.toLowerCase())) {
    throw new Error("--host is the local management host; pass a remote server URL as the first argument");
  }
  if (opts.codexProfiles.length) {
    if (!opts.tools || !resolveTools(opts.tools).some(tool => tool.id === "codex")) throw new Error("--codex-profile requires --tools codex (or all)");
    for (const profile of opts.codexProfiles) {
      const eq = profile.indexOf("=");
      const name = profile.slice(0, eq).toLowerCase();
      const model = profile.slice(eq + 1);
      if (eq < 1 || !/^[a-z0-9_-]{1,64}$/.test(name) || name === "config" || !model.trim() || model.length > 256 || /[\r\n"\\]/.test(model)) throw new Error("--codex-profile expects a valid <name>=<model>");
    }
  }
  if (opts.save && !opts.url) throw new Error("--save requires a remote server URL");
  return opts;
}

function maskKey(key) {
  if (!key || key.length < 12) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// Server-controlled strings get printed — strip control characters so an
// attacker-controlled value cannot inject terminal escape sequences.
function stripControl(text) {
  return String(text ?? "").replace(/[\x00-\x1f\x7f]/g, "");
}

// ── Interactive prompts (enquirer is loaded lazily; tests and non-TTY runs
//    never touch it) ─────────────────────────────────────────────────────────
async function promptTools(tools) {
  const { MultiSelect } = require("enquirer");
  return runPrompt(new MultiSelect({
    message: "Select CLI tools to configure (space to toggle, enter to confirm)",
    choices: tools.map((t) => ({ name: t.id, message: t.name, enabled: t.id === "claude" })),
    validate: (v) => v.length > 0 || "Select at least one tool",
  }));
}

async function promptModel(tool, models) {
  const { Select, Input } = require("enquirer");
  const manual = { name: "__manual__", message: "✎ Enter a model id manually…" };
  if (Array.isArray(models) && models.length) {
    const pick = await runPrompt(new Select({
      message: `Model for ${tool.name}`,
      limit: 12,
      choices: [...models, manual],
    }));
    if (pick !== manual.name) return pick;
  }
  return runPrompt(new Input({ message: `Model id for ${tool.name} (empty to skip this tool)` }));
}

async function selectTools(opts, deps) {
  if (opts.tools) return resolveTools(opts.tools);
  if (process.stdin.isTTY) return resolveTools(await deps.prompts.tools(TOOLS));
  return resolveTools(["claude"]);
}

/**
 * Resolve the model for one tool: --model beats the interactive prompt; a
 * non-TTY run without --model skips the tool (upstream behaviour).
 * @returns {Promise<string|null>}
 */
async function resolveModel(tool, opts, serverModels, deps) {
  if (!tool.needsModel) return null;
  if (opts.model) return opts.model;
  if (process.stdin.isTTY) {
    const picked = await deps.prompts.model(tool, serverModels);
    return picked && picked.trim() ? picked.trim() : null;
  }
  return null;
}

function claudeEnvModels(opts) {
  const out = {};
  for (const tier of CLAUDE_TIERS) {
    if (opts.models[tier.flag] || opts.model) out[tier.envKey] = opts.models[tier.flag] || opts.model;
  }
  return out;
}

async function applyCodexProfiles(profiles, writer = localConfig) {
  const results = [];
  for (const raw of profiles) {
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const model = eq === -1 ? "" : raw.slice(eq + 1);
    if (!name.trim() || !model.trim()) {
      results.push({ input: raw, ok: false, error: "expected <name>=<model>" });
      continue;
    }
    const res = await writer.saveCodexProfile(name.trim(), model.trim());
    results.push({ input: raw, name: name.trim(), model: model.trim(), ok: res.success, error: res.success ? null : res.error });
  }
  return results;
}

async function runConnect(opts, deps) {
  const writer = deps.writer || localConfig;
  const tools = await selectTools(opts, deps);
  if (opts.reset) {
    let failed = false;
    for (const tool of tools) {
      const result = await writer.resetCliToolSettings(tool.id);
      if (!result.success) failed = true;
      console.log(`${result.success ? "✓" : "✗"} ${tool.name}: ${result.success ? "settings restored" : "reset failed"}`);
    }
    return failed ? 1 : 0;
  }

  let connection;
  if (opts.url) {
    connection = await authenticate(opts.url, { authKey: opts.authKey, save: opts.save,
      promptKey: deps.prompts.key, fetchImpl: deps.fetch });
  } else {
    api.configure({ host: opts.host, port: opts.port, protocol: "http:" });
    connection = {
      mint: async (name) => { const result = await api.createApiKey(name); if (!result.success) throw new Error("Cannot create a key on the local gateway; start it or pass a remote URL"); return result.data; },
      models: async () => { const result = await api.getAvailableModels(); return result.success ? result.data?.data || [] : []; },
      revoke: (id) => api.deleteApiKey(id),
    };
  }
  let minted;
  let used = false;
  try {
    minted = await connection.mint(opts.keyName);
    if (typeof minted?.key !== "string" || !minted.key) throw new Error("Server did not return the new key's one-time secret");
    let catalog = [];
    try { catalog = await connection.models(minted.key); } catch {
      if (tools.some(tool => tool.needsModel) && !opts.model) throw new Error("Cannot load models; retry or select one with --model");
    }
    const serverModels = (Array.isArray(catalog) ? catalog : []).filter((model) => !model.kind || model.kind === "llm").map((model) => model.id).filter(Boolean);
    const baseUrl = opts.baseUrl || opts.url || `http://localhost:${opts.port}`;
    const applied = [];
    let failed = 0;
    for (const tool of tools) {
      const model = await resolveModel(tool, opts, serverModels, deps)
        || (tool.needsModel && !process.stdin.isTTY ? serverModels[0] : null);
      if (tool.needsModel && !model) {
        console.log(`✗ ${tool.name}: select a model with --model`);
        failed++;
        continue;
      }
      const body = tool.buildBody({ baseUrl, apiKey: minted.key, model,
        claudeModels: claudeEnvModels(opts) });
      let result;
      try { result = await writer.applyCliToolSettings(tool.id, body); }
      catch { result = { success: false }; }
      if (!result.success) { console.log(`✗ ${tool.name}: configuration failed`); failed++; continue; }
      used = true;
      applied.push(tool.id);
      console.log(`✓ ${tool.name}: configured${model ? ` (${stripControl(model)})` : ""}`);
    }
    if (opts.codexProfiles.length) {
      if (!applied.includes("codex")) throw new Error("--codex-profile requires configuring Codex in the same run");
      for (const result of await applyCodexProfiles(opts.codexProfiles, writer)) {
        if (!result.ok) failed++;
        console.log(`${result.ok ? "✓" : "✗"} Codex profile ${stripControl(result.name || result.input)}`);
      }
    }
    console.log(`Endpoint: ${stripControl(baseUrl)}/v1`);
    console.log(`New client key: ${maskKey(minted.key)}`);
    if (opts.printEnv) {
      const quote = (text) => "'" + String(text).replace(/'/g, "'\\''") + "'";
      console.log(`export OPENAI_BASE_URL=${quote(`${baseUrl}/v1`)}`);
      console.log(`export OPENAI_API_KEY=${quote(minted.key)}`);
      used = true;
    }
    return failed ? 1 : 0;
  } finally {
    if (minted?.id && !used) await connection.revoke(minted.id).catch(() => {});
  }
}

async function run(argv, deps = {}) {
  const prompts = { tools: promptTools, model: promptModel, key: async () => {
    if (!process.stdin.isTTY) throw new Error("Set SWITCHBOARD_CONNECT_KEY or pass --api-key for dashboard sign-in");
    const { Password } = require("enquirer");
    return runPrompt(new Password({ message: "Dashboard API key" }));
  }, ...deps.prompts };
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(HELP);
      return 0;
    }
    if (opts.listTools) {
      for (const t of TOOLS) console.log(`${t.id.padEnd(14)} ${t.name}`);
      return 0;
    }
    return await runConnect(opts, { ...deps, prompts });
  } catch (err) {
    if (err instanceof Cancelled) {
      console.log("Cancelled.");
      return 130;
    }
    console.error(`❌ ${stripControl(err?.message || err)}`);
    return 1;
  }
}

module.exports = {
  run,
  HELP,
  __test__: { parseArgs, maskKey, stripControl, selectTools, resolveModel, applyCodexProfiles, Cancelled },
};
