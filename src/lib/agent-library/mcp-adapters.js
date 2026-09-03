// @ts-check
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { isManagedMcpKey } from "./markers.js";
import { atomicWriteFile } from "./fs-utils.js";

/**
 * Keep ${VAR} placeholders — do NOT expand secrets into written config files.
 * @param {string} value
 */
function preserveEnvRefs(value) {
  return String(value);
}

/**
 * OpenCode resolves environment references with {env:NAME}, not ${NAME}.
 * @param {string} value
 */
function toOpenCodeEnvRefs(value) {
  return String(value).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => `{env:${name}}`
  );
}

/**
 * Cursor interpolates secrets as ${env:NAME}, not ${NAME}.
 * Already-qualified ${env:NAME} refs pass through untouched.
 * @param {unknown} value
 */
function toCursorEnvRefs(value) {
  return String(value).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, name) => `\${env:${name}}`
  );
}

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_ENV_REF_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Classify a library secret placeholder for agents without ${VAR} expansion.
 * Returns { name, prefix } when the whole value is `${NAME}` (prefix "")
 * or `Bearer ${NAME}` (prefix "Bearer "), else null.
 * @param {unknown} value
 */
function parseEnvRef(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  let m = ENV_REF_RE.exec(v);
  if (m) return { name: m[1], prefix: "" };
  m = BEARER_ENV_REF_RE.exec(v);
  if (m) return { name: m[1], prefix: "Bearer " };
  return null;
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Deliberate projection map: every JSON kind selects an explicit
// toAgentMcpEntry branch (claude-* fall through to "claude").
const KIND_TO_AGENT = {
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
  omp: "omp",
  codex: "codex",
};

/**
 * @param {import("./mcp-store.js").McpServerDef} server
 * @param {"claude"|"cursor"|"gemini"|"opencode"|"codex"|"omp"} agent
 */
function toAgentMcpEntry(server, agent) {
  const transport = server.transport || (server.url ? "http" : "stdio");

  if (agent === "codex") {
    // Codex has no ${VAR} expansion: pure refs become env_vars (stdio) or
    // env_http_headers / bearer_token_env_var (http); anything else stays
    // literal. startup/tool timeouts are per-server keys, valid on both
    // transports.
    const timeouts = {};
    if (typeof server.startupTimeoutSec === "number") {
      timeouts.startup_timeout_sec = server.startupTimeoutSec;
    }
    if (typeof server.toolTimeoutSec === "number") {
      timeouts.tool_timeout_sec = server.toolTimeoutSec;
    }
    const tools =
      server.tools && Object.keys(server.tools).length ? server.tools : undefined;
    if (transport === "stdio") {
      const env = {};
      const envVars = [];
      for (const [k, v] of Object.entries(server.env || {})) {
        const ref = parseEnvRef(v);
        if (ref && !ref.prefix && ref.name === k) envVars.push(k);
        else env[k] = v;
      }
      const entry = {
        command: server.command,
        args: server.args || [],
        ...timeouts,
      };
      if (Object.keys(env).length) entry.env = env;
      if (envVars.length) entry.env_vars = envVars;
      if (tools) entry.tools = tools;
      return entry;
    }
    const httpHeaders = {};
    const envHttpHeaders = {};
    let bearerTokenEnvVar;
    for (const [k, v] of Object.entries(server.headers || {})) {
      const ref = parseEnvRef(v);
      if (ref && !ref.prefix) envHttpHeaders[k] = ref.name;
      else if (ref && ref.prefix === "Bearer " && k.toLowerCase() === "authorization") {
        bearerTokenEnvVar = ref.name;
      } else httpHeaders[k] = v;
    }
    const entry = { url: server.url, ...timeouts };
    if (Object.keys(httpHeaders).length) entry.http_headers = httpHeaders;
    if (Object.keys(envHttpHeaders).length) entry.env_http_headers = envHttpHeaders;
    if (bearerTokenEnvVar) entry.bearer_token_env_var = bearerTokenEnvVar;
    if (tools) entry.tools = tools;
    return entry;
  }

  if (agent === "cursor") {
    // Cursor interpolates ${env:NAME}, not ${NAME} — rewrite every
    // user-facing string field. `type` is required by Cursor's schema.
    if (transport === "stdio") {
      const entry = {
        type: "stdio",
        command: toCursorEnvRefs(server.command || ""),
        args: (server.args || []).map(toCursorEnvRefs),
      };
      if (server.env && Object.keys(server.env).length) {
        entry.env = Object.fromEntries(
          Object.entries(server.env).map(([k, v]) => [k, toCursorEnvRefs(v)])
        );
      }
      return entry;
    }
    const entry = {
      url: server.url,
      type: transport === "sse" ? "sse" : "http",
    };
    if (server.headers && Object.keys(server.headers).length) {
      entry.headers = Object.fromEntries(
        Object.entries(server.headers).map(([k, v]) => [k, toCursorEnvRefs(v)])
      );
    }
    return entry;
  }

  if (agent === "opencode") {
    if (transport === "stdio") {
      return {
        type: "local",
        command: [server.command, ...(server.args || [])],
        environment: Object.fromEntries(
          Object.entries(server.env || {}).map(([k, v]) => [k, toOpenCodeEnvRefs(v)])
        ),
        enabled: true,
      };
    }
    return {
      type: "remote",
      url: server.url,
      headers: Object.fromEntries(
        Object.entries(server.headers || {}).map(([k, v]) => [k, toOpenCodeEnvRefs(v)])
      ),
      enabled: true,
    };
  }

  if (agent === "gemini") {
    if (transport === "stdio") {
      return {
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      };
    }
    return {
      url: server.url,
      type: transport === "sse" ? "sse" : "http",
      headers: server.headers || {},
    };
  }

  // omp (pi-mcp-adapter, https://github.com/ofriw/pi-mcp-adapter) is an
  // explicit branch even though it matches the Claude shape today:
  // mcpServers.<name> takes { command, args, env } (stdio) or
  // { url, headers } (remote, ${VAR}-interpolated). Re-verify here if
  // pi-mcp-adapter changes its accepted keys.
  if (agent === "omp") {
    return toClaudeShapedEntry(server, transport);
  }

  return toClaudeShapedEntry(server, transport);
}

/**
 * Claude Code JSON shape: { command, args, env } stdio,
 * { url, type, headers } remote. Both Claude Code and Gemini CLI expand
 * ${VAR}, so placeholders pass through verbatim.
 * @param {import("./mcp-store.js").McpServerDef} server
 * @param {string} transport
 */
function toClaudeShapedEntry(server, transport) {
  if (transport === "stdio") {
    const entry = {
      command: server.command,
      args: server.args || [],
    };
    if (server.env && Object.keys(server.env).length) {
      entry.env = Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [k, preserveEnvRefs(v)])
      );
    }
    return entry;
  }

  const entry = { url: server.url, type: transport === "sse" ? "sse" : "http" };
  if (server.headers && Object.keys(server.headers).length) {
    entry.headers = Object.fromEntries(
      Object.entries(server.headers).map(([k, v]) => [k, preserveEnvRefs(v)])
    );
  }
  return entry;
}

/**
 * Merge Switchboard-managed MCP servers into a JSON config file.
 *
 * Safety:
 * - Only delete keys listed in previouslyManaged (state), not every sb-* key
 * - Only overwrite existing key if it is in previouslyManaged OR key is absent
 * - neverOverwriteUser: skip if key exists and not previously managed
 * - Refuse if mcp container has unexpected non-object shape
 *
 * @param {string} filePath
 * @param {import("./mcp-store.js").McpServerDef[]} servers
 * @param {{ kind: string, neverOverwriteUser: boolean, dryRun?: boolean, previouslyManaged?: string[] }} opts
 */
export async function mergeJsonMcpConfig(filePath, servers, opts) {
  const kind = opts.kind;
  const previouslyManaged = new Set(opts.previouslyManaged || []);
  let mapKey = "mcpServers";
  if (kind === "opencode") mapKey = "mcp";

  // Bounded read→merge→write retry: ~/.claude.json is Claude Code's live
  // state file and a running session may rewrite it between our read and
  // our write. If the mtime/size moved, re-read and re-apply instead of
  // clobbering the external update (last writer still wins on the final
  // attempt, but only after re-merging onto the freshest content).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let existing = {};
    let indent = 2;
    let snap = null;
    if (existsSync(filePath)) {
      try {
        const st = await fs.stat(filePath);
        snap = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        snap = null;
      }
      let raw;
      try {
        raw = await fs.readFile(filePath, "utf-8");
      } catch (e) {
        if (e?.code === "ENOENT") raw = null;
        else throw e;
      }
      if (raw != null) {
        indent = detectJsonIndent(raw);
        try {
          existing = JSON.parse(raw);
        } catch {
          if (opts.neverOverwriteUser) {
            return {
              ok: false,
              error: "mcp_parse_failed",
              message: `Cannot parse ${filePath}; refusing to overwrite`,
              path: filePath,
            };
          }
          existing = {};
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(existing, mapKey) && !isPlainObject(existing[mapKey])) {
      if (opts.neverOverwriteUser) {
        return {
          ok: false,
          error: "mcp_shape_conflict",
          message: `${filePath}: "${mapKey}" exists but is not a plain object; refusing to overwrite`,
          path: filePath,
        };
      }
    }

    const currentMap = isPlainObject(existing[mapKey]) ? { ...existing[mapKey] } : {};

    const enabled = servers.filter((s) => s.enabled !== false);
    const desiredKeys = new Set(enabled.map((s) => s.id));

    const removed = [];
    // Only remove keys we previously managed that are no longer desired
    for (const key of Object.keys(currentMap)) {
      if (previouslyManaged.has(key) && isManagedMcpKey(key) && !desiredKeys.has(key)) {
        delete currentMap[key];
        removed.push(key);
      }
    }

    const written = [];
    const skipped = [];
    for (const server of enabled) {
      const key = server.id;
      if (!isManagedMcpKey(key)) {
        skipped.push({ key, reason: "not_namespaced" });
        continue;
      }

      const agent = KIND_TO_AGENT[kind] || "claude";
      const entry = toAgentMcpEntry(server, agent);

      const exists = Object.prototype.hasOwnProperty.call(currentMap, key);
      const weOwn = previouslyManaged.has(key);

      if (exists && !weOwn && opts.neverOverwriteUser) {
        skipped.push({ key, reason: "user_owned_or_unknown_sb_key" });
        continue;
      }

      currentMap[key] = entry;
      written.push(key);
    }

    const next = { ...existing, [mapKey]: currentMap };

    let warning;
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      if (snap && (await configChangedSince(filePath, snap))) {
        if (attempt + 1 < MAX_ATTEMPTS) continue; // re-read and re-apply
        warning = "external_write_race"; // final attempt: write anyway, flag it
      }
      await atomicWriteFile(filePath, JSON.stringify(next, null, indent));
    }

    return {
      ok: true,
      path: filePath,
      written,
      removed,
      skipped,
      dryRun: !!opts.dryRun,
      ...(warning ? { warning } : {}),
    };
  }
  // Unreachable: the loop always returns on the final attempt.
  throw new Error("mergeJsonMcpConfig: retry loop exhausted");
}

/**
 * Snapshot-compare a config file against a pre-read stat.
 * @param {string} filePath
 * @param {{ mtimeMs: number, size: number }|null} snap
 */
async function configChangedSince(filePath, snap) {
  if (!snap) return existsSync(filePath);
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs !== snap.mtimeMs || st.size !== snap.size;
  } catch {
    return true;
  }
}

/**
 * Preserve the file's existing indentation (tab vs N-space) so merges
 * into user-tracked files like ~/.claude.json don't re-indent everything.
 * @param {string} raw
 */
function detectJsonIndent(raw) {
  const m = /^([ \t]+)"[^"\n]*":/m.exec(raw);
  if (!m) return 2;
  if (m[1].startsWith("\t")) return "\t";
  return m[1].length || 2;
}

/**
 * Merge into Codex config.toml — only blocks we previously managed (marker region).
 * @param {string} filePath
 * @param {import("./mcp-store.js").McpServerDef[]} servers
 * @param {{ neverOverwriteUser: boolean, dryRun?: boolean, previouslyManaged?: string[] }} opts
 */
export async function mergeCodexMcpConfig(filePath, servers, opts) {
  let raw = "";
  if (existsSync(filePath)) {
    raw = await fs.readFile(filePath, "utf-8");
  }

  // Only strip our marked block (not arbitrary [mcp_servers.sb-*] that user may own)
  let base = raw.replace(
    /\n?# --- switchboard-agent-library-mcp-start ---[\s\S]*?# --- switchboard-agent-library-mcp-end ---\n?/g,
    "\n"
  );

  // If no marker block but old-style sb sections exist and neverOverwrite, leave them
  // (we only manage the marked block going forward)

  const enabled = servers.filter((s) => s.enabled !== false && isManagedMcpKey(s.id));
  if (!enabled.length) {
    if (!opts.dryRun && existsSync(filePath)) {
      await atomicWriteFile(filePath, base.trimEnd() + "\n");
    }
    return {
      ok: true,
      path: filePath,
      written: [],
      removed: opts.previouslyManaged || [],
      dryRun: !!opts.dryRun,
    };
  }

  // Conflict: if user already has [mcp_servers.sb-X] outside our block and we never managed it
  const previouslyManaged = new Set(opts.previouslyManaged || []);
  const skipped = [];
  const toWrite = [];
  for (const server of enabled) {
    const sectionRe = new RegExp(
      `\\[mcp_servers\\.${escapeRe(server.id)}\\]`,
      "m"
    );
    const inBase = sectionRe.test(base);
    if (inBase && !previouslyManaged.has(server.id) && opts.neverOverwriteUser) {
      skipped.push({ key: server.id, reason: "user_owned_toml_section" });
      continue;
    }
    // Remove loose section if we own it
    if (inBase && previouslyManaged.has(server.id)) {
      base = base.replace(
        new RegExp(
          `\\n?\\[mcp_servers\\.${escapeRe(server.id)}\\][\\s\\S]*?(?=\\n\\[|\\n*$)`,
          "g"
        ),
        "\n"
      );
    }
    toWrite.push(server);
  }

  const lines = [
    "",
    "# --- switchboard-agent-library-mcp-start ---",
    "# Managed by Switchboard Agent Library. Do not edit this block by hand.",
  ];

  for (const server of toWrite) {
    const entry = toAgentMcpEntry(server, "codex");
    skipped.push(...collectCodexSkipped(server));
    // Quote dotted ids: [mcp_servers."sb-foo.bar"] so TOML is one key, not nested tables
    const table = tomlTableName(server.id);
    lines.push(`[mcp_servers.${table}]`);
    if (entry.command) {
      lines.push(`command = ${tomlString(entry.command)}`);
      if (entry.args?.length) {
        lines.push(`args = ${tomlArray(entry.args)}`);
      }
      if (typeof entry.startup_timeout_sec === "number") {
        lines.push(`startup_timeout_sec = ${entry.startup_timeout_sec}`);
      }
      if (typeof entry.tool_timeout_sec === "number") {
        lines.push(`tool_timeout_sec = ${entry.tool_timeout_sec}`);
      }
      // Bare keys must precede the [..env] sub-table or TOML nests them in it.
      if (entry.env_vars?.length) {
        lines.push(`env_vars = ${tomlArray(entry.env_vars)}`);
      }
      if (entry.env && Object.keys(entry.env).length) {
        lines.push(`[mcp_servers.${table}.env]`);
        for (const [k, v] of Object.entries(entry.env)) {
          lines.push(`${tomlKey(k)} = ${tomlString(preserveEnvRefs(v))}`);
        }
      }
    } else if (entry.url) {
      lines.push(`url = ${tomlString(entry.url)}`);
      if (typeof entry.startup_timeout_sec === "number") {
        lines.push(`startup_timeout_sec = ${entry.startup_timeout_sec}`);
      }
      if (typeof entry.tool_timeout_sec === "number") {
        lines.push(`tool_timeout_sec = ${entry.tool_timeout_sec}`);
      }
      if (entry.bearer_token_env_var) {
        lines.push(`bearer_token_env_var = ${tomlString(entry.bearer_token_env_var)}`);
      }
      if (entry.env_http_headers && Object.keys(entry.env_http_headers).length) {
        lines.push(`[mcp_servers.${table}.env_http_headers]`);
        for (const [k, v] of Object.entries(entry.env_http_headers)) {
          lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
        }
      }
      if (entry.http_headers && Object.keys(entry.http_headers).length) {
        lines.push(`[mcp_servers.${table}.http_headers]`);
        for (const [k, v] of Object.entries(entry.http_headers)) {
          lines.push(`${tomlKey(k)} = ${tomlString(preserveEnvRefs(v))}`);
        }
      }
    }
    if (entry.tools && Object.keys(entry.tools).length) {
      for (const [toolName, toolCfg] of Object.entries(entry.tools)) {
        const clean = {};
        for (const [k, v] of Object.entries(toolCfg)) {
          const checked = checkCodexToolValue(server.id, toolName, k, v);
          if (checked.ok) clean[k] = checked.value;
          else skipped.push(checked.skipped);
        }
        if (!Object.keys(clean).length) continue;
        lines.push(`[mcp_servers.${table}.tools.${tomlTableName(toolName)}]`);
        for (const [k, v] of Object.entries(clean)) {
          lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
        }
      }
    }
    lines.push("");
  }
  lines.push("# --- switchboard-agent-library-mcp-end ---", "");

  const next = (base.trimEnd() + "\n" + lines.join("\n")).replace(/\n{3,}/g, "\n\n");

  if (!opts.dryRun) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, next);
  }

  return {
    ok: true,
    path: filePath,
    written: toWrite.map((s) => s.id),
    removed: [],
    skipped,
    dryRun: !!opts.dryRun,
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Codex [mcp_servers.<id>.tools.<tool>] keys we know how to render.
// approval_mode is a string enum; output_token_limit is an integer —
// writing it quoted breaks Codex's strict config deserializer.
const CODEX_APPROVAL_MODES = new Set(["auto", "prompt", "writes", "approve"]);

/**
 * Validate one per-tool value for the Codex TOML writer.
 * Unknown keys and out-of-enum values are skipped (reported, not written)
 * so one bad value can't brick the user's whole config.toml.
 */
function checkCodexToolValue(serverId, toolName, key, value) {
  const skipped = (reason) => ({
    ok: false,
    skipped: { key: `${serverId}.tools.${toolName}.${key}`, reason },
  });
  if (key === "approval_mode") {
    if (typeof value === "string" && CODEX_APPROVAL_MODES.has(value)) {
      return { ok: true, value };
    }
    return skipped("codex_approval_mode_invalid");
  }
  if (key === "output_token_limit") {
    // Legacy catalogs stringified numbers — recover when unambiguous.
    const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
    // Positive safe integer only: String(1e21) would render exponent form.
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) {
      return { ok: true, value: n };
    }
    return skipped("codex_output_token_limit_invalid");
  }
  return skipped("codex_tool_key_unsupported");
}

/**
 * Report stdio env refs Codex cannot consume: only a pure ${NAME} whose
 * key equals the var name becomes env_vars; every other ref is written
 * literally (secrets stay out of disk) and flagged so the UI can warn.
 * @param {import("./mcp-store.js").McpServerDef} server
 */
function collectCodexSkipped(server) {
  const out = [];
  const transport = server.transport || (server.url ? "http" : "stdio");
  if (transport === "stdio") {
    for (const [k, v] of Object.entries(server.env || {})) {
      const ref = parseEnvRef(v);
      if (ref && (ref.prefix || ref.name !== k)) {
        out.push({ key: `${server.id}.env.${k}`, reason: "codex_env_ref_unsupported" });
      }
    }
  }
  return out;
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

/** Native TOML scalar: numbers/booleans unquoted, everything else a string. */
function tomlValue(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return tomlString(v);
}

function tomlArray(arr) {
  return `[${arr.map((x) => tomlString(x)).join(", ")}]`;
}


function tomlKey(k) {
  // TOML bare keys allow A-Za-z0-9_- (so X-Api-Key stays unquoted);
  // anything else (dots, spaces, leading digits) is quoted.
  if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(k)) return k;
  return tomlString(k);
}

/** Bare key if safe, else quoted — prevents sb-foo.bar becoming nested tables. */
function tomlTableName(id) {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) && !id.includes(".")) return id;
  return tomlString(id);
}
