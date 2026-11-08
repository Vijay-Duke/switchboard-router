/**
 * `switchboard connect` — point local CLI tools (Claude Code, Codex, …) at
 * the LOCAL Switchboard gateway.
 *
 * Flow: authenticate to the local management API with the machine-bound CLI
 * token (no passwords), MINT A NEW client API key (POST /api/keys returns the
 * full secret exactly once — stored secrets are never readable back), then
 * apply each tool's settings through the server's own writer routes
 * (POST /api/cli-tools/<tool>-settings) passing that fresh one-time secret.
 *
 * Security rules honored here:
 *   - existing keys are never listed to reuse them (GET /api/keys is not
 *     called; every run mints a new key so no stored secret is ever read back)
 *   - the minted key is written into the tool configs (owner-only files, done
 *     by the server writers) and is otherwise only ever displayed masked
 *   - nothing is stored in browser localStorage (this is a CLI; state files
 *     are none) and secrets never enter the log output
 *
 * `--reset` removes Switchboard settings from the selected tools instead.
 */

const os = require("os");
const api = require("../api/client");
const { TOOLS, TOOL_IDS, CLAUDE_TIERS, resolveTools } = require("./connectTools");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "localhost";

const HELP = `
Usage: switchboard connect [options]

Configure CLI tools on THIS machine to use the local Switchboard gateway.
Talks to the management API of an already-running gateway, mints a NEW client
API key for the tools (existing stored secrets are never read back), and
writes each tool's config through the server's own writer routes — the same
code the dashboard uses.

  switchboard connect                          # interactive: pick tools + models
  switchboard connect --tools claude,codex     # non-interactive tool selection
  switchboard connect --tools all --model cc/claude-sonnet-5
  switchboard connect --reset --tools claude   # remove Switchboard settings

Options:
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
                         http://localhost:<port>)
  --host <host>          Management API host (default: ${DEFAULT_HOST})
  --port <port>          Management API port (default: ${DEFAULT_PORT})
  --print-env            Print OpenAI-compatible env vars for other CLIs
                         (includes the freshly minted key — copy it somewhere
                         safe; it is not shown again)
  --list-tools           List the supported tools and exit
  --reset                Remove Switchboard settings from the selected tools
  -h, --help             Show this help

Every run mints a NEW API key (one-time secret). Remove unused ones in the
dashboard or the API Keys terminal menu.

Undo:  switchboard connect --reset --tools <same list>
`;

// Enquirer rejects with an empty value on Ctrl+C / Esc.
class Cancelled extends Error {}
const runPrompt = (p) => p.run().catch((err) => { throw err || new Cancelled("Cancelled"); });

function parseArgs(argv) {
  const opts = {
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
    if (a === "--tools") opts.tools = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--model" || a === "-m") opts.model = next();
    else if (a === "--key-name") opts.keyName = next();
    else if (a === "--base-url") {
      const v = next();
      try {
        const u = new URL(v);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
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
    else throw new Error(`Unknown option: ${a}`);
  }
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

function cliTokenNote() {
  return "Authenticated with the machine-bound CLI token (no password needed).";
}

async function mintApiKey(opts) {
  const result = await api.createApiKey(opts.keyName);
  if (!result.success) {
    const unreachable = /network error/i.test(String(result.error || ""));
    throw new Error(
      unreachable
        ? `Cannot reach Switchboard at ${opts.host}:${opts.port} — is it running? Start it with: switchboard start`
        : `Minting a new API key failed: ${result.error}`,
    );
  }
  if (!result.data?.key) {
    throw new Error("The server created a key but did not return its one-time secret");
  }
  return result.data;
}

function claudeEnvModels(opts) {
  const out = {};
  for (const tier of CLAUDE_TIERS) {
    if (opts.models[tier.flag]) out[tier.envKey] = opts.models[tier.flag];
  }
  return out;
}

async function applyCodexProfiles(profiles) {
  const results = [];
  for (const raw of profiles) {
    const eq = raw.indexOf("=");
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const model = eq === -1 ? "" : raw.slice(eq + 1);
    if (!name.trim() || !model.trim()) {
      results.push({ input: raw, ok: false, error: "expected <name>=<model>" });
      continue;
    }
    const res = await api.saveCodexProfile(name.trim(), model.trim());
    results.push({ input: raw, name: name.trim(), model: model.trim(), ok: res.success, error: res.success ? null : res.error });
  }
  return results;
}

async function runConnect(opts, deps) {
  api.configure({ host: opts.host, port: opts.port });
  const tools = await selectTools(opts, deps);

  if (opts.reset) {
    let failed = 0;
    for (const tool of tools) {
      try {
        const res = await api.resetCliToolSettings(tool.id);
        if (!res.success) throw new Error(stripControl(res.error) || `HTTP ${res.statusCode}`);
        console.log(`✅ ${tool.name}: ${stripControl(res.data?.message) || "Switchboard settings removed"}`);
      } catch (err) {
        failed++;
        console.log(`❌ ${tool.name}: ${err.message}`);
      }
    }
    return failed ? 1 : 0;
  }

  console.log(`• Talking to the local gateway at http://${opts.host}:${opts.port} (${cliTokenNote()})`);

  // 1. Mint a NEW key. We never list existing keys: stored secrets are not
  //    readable, and re-reading them must not become possible either.
  const minted = await mintApiKey(opts);
  const apiKey = minted.key;
  console.log(`• Minted new API key "${minted.name}" (${maskKey(apiKey)}) — existing keys are never reused or read back`);

  // 2. Model catalogue for the interactive picker.
  let serverModels = [];
  if (!opts.model && process.stdin.isTTY) {
    const models = await api.getAvailableModels();
    if (models.success) serverModels = (models.data?.data || []).map((m) => m.id).filter(Boolean);
  }

  const baseUrl = opts.baseUrl || `http://localhost:${opts.port}`;

  // 3. Resolve models, then apply each tool through the server's writers.
  let failed = 0;
  let skipped = 0;
  const applied = [];
  const perToolModel = {};
  for (const tool of tools) {
    const model = await resolveModel(tool, opts, serverModels, deps);
    perToolModel[tool.id] = model;
    if (tool.needsModel && !model) {
      skipped++;
      console.log(`⏭  ${tool.name}: no model selected — skipped (pass --model <id>)`);
      continue;
    }
    try {
      const body = tool.buildBody({
        baseUrl,
        apiKey,
        model,
        claudeModels: claudeEnvModels(opts),
      });
      const res = await api.applyCliToolSettings(tool.id, body);
      if (!res.success) throw new Error(stripControl(res.error) || `HTTP ${res.statusCode}`);
      // Read the config back (GET carries the file paths) so we can point at
      // the exact files written. Only path strings are used — never the
      // secret the writer echoes back.
      let files = [];
      const readBack = await api.getCliToolSettings(tool.id);
      if (readBack.success) files = tool.files(readBack.data);
      applied.push(tool.id);
      console.log(`✅ ${tool.name}${files.length ? ` → ${files.join(", ")}` : ""}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${tool.name}: ${err.message}`);
    }
  }

  if (opts.codexProfiles.length) {
    if (!applied.includes("codex")) {
      console.log("⚠ --codex-profile ignored: codex was not configured in this run");
    } else {
      for (const r of await applyCodexProfiles(opts.codexProfiles)) {
        if (r.ok) console.log(`✅ codex profile "${r.name}" → ${r.model} (use: codex -p ${r.name})`);
        else console.log(`❌ codex profile "${r.input}": ${r.error}`);
        if (!r.ok) failed++;
      }
    }
  }

  console.log(`   Base URL: ${baseUrl}/v1`);
  for (const [id, m] of Object.entries(perToolModel)) if (m) console.log(`   ${id} model: ${m}`);
  const tiers = Object.entries(opts.models);
  for (const [flag, m] of tiers) console.log(`   claude ${flag}: ${m}`);
  if (tools.some((t) => t.id === "claude") && !tiers.length) {
    console.log("   claude tiers: left unset — Claude Code's own defaults apply (or pass --sonnet <model> etc.)");
  }
  console.log(`   API key: ${maskKey(apiKey)} (full secret only lives in the tool configs above)`);
  console.log(`   Undo: switchboard connect --reset --tools ${tools.map((t) => t.id).join(",")}`);

  if (opts.printEnv) {
    console.log("\nOpenAI-compatible CLIs (codex, opencode, aider, …):");
    console.log(`   OPENAI_BASE_URL=${baseUrl}/v1`);
    console.log(`   OPENAI_API_KEY=${apiKey}`);
    console.log("   (freshly minted key — shown once, copy it now)");
  }

  // A skipped tool was not configured, so the run did not do what was asked.
  return failed || skipped ? 1 : 0;
}

async function run(argv, deps = {}) {
  const prompts = deps.prompts || { tools: promptTools, model: promptModel };
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
    return await runConnect(opts, { prompts });
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
  __test__: { parseArgs, maskKey, stripControl, selectTools, resolveModel, mintApiKey, applyCodexProfiles, Cancelled },
};
