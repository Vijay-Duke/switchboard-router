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

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {import("./mcp-store.js").McpServerDef} server
 * @param {"claude"|"cursor"|"gemini"|"opencode"|"codex"} agent
 */
function toAgentMcpEntry(server, agent) {
  const transport = server.transport || (server.url ? "http" : "stdio");

  if (agent === "codex") {
    if (transport === "stdio") {
      return {
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      };
    }
    return {
      url: server.url,
      http_headers: server.headers || {},
    };
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
  let existing = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(await fs.readFile(filePath, "utf-8"));
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

  let mapKey = "mcpServers";
  if (kind === "opencode") mapKey = "mcp";

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

    const agent =
      kind === "cursor"
        ? "cursor"
        : kind === "gemini"
          ? "gemini"
          : kind === "opencode"
            ? "opencode"
            : "claude";
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

  if (!opts.dryRun) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(next, null, 2));
  }

  return {
    ok: true,
    path: filePath,
    written,
    removed,
    skipped,
    dryRun: !!opts.dryRun,
  };
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
    // Quote dotted ids: [mcp_servers."sb-foo.bar"] so TOML is one key, not nested tables
    const table = tomlTableName(server.id);
    lines.push(`[mcp_servers.${table}]`);
    if (entry.command) {
      lines.push(`command = ${tomlString(entry.command)}`);
      if (entry.args?.length) {
        lines.push(`args = ${tomlArray(entry.args)}`);
      }
      if (entry.env && Object.keys(entry.env).length) {
        lines.push(`[mcp_servers.${table}.env]`);
        for (const [k, v] of Object.entries(entry.env)) {
          lines.push(`${k} = ${tomlString(preserveEnvRefs(v))}`);
        }
      }
    } else if (entry.url) {
      lines.push(`url = ${tomlString(entry.url)}`);
      if (entry.http_headers && Object.keys(entry.http_headers).length) {
        lines.push(`[mcp_servers.${table}.http_headers]`);
        for (const [k, v] of Object.entries(entry.http_headers)) {
          lines.push(`${tomlKey(k)} = ${tomlString(preserveEnvRefs(v))}`);
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

function tomlString(s) {
  return JSON.stringify(String(s));
}

function tomlArray(arr) {
  return `[${arr.map((x) => tomlString(x)).join(", ")}]`;
}

function tomlKey(k) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return k;
  return tomlString(k);
}

/** Bare key if safe, else quoted — prevents sb-foo.bar becoming nested tables. */
function tomlTableName(id) {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) && !id.includes(".")) return id;
  return tomlString(id);
}
