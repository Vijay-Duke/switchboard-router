// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { ensureLibraryDirs, getMcpPath } from "./paths.js";
import { managedMcpKey } from "./markers.js";
import { atomicWriteFile } from "./fs-utils.js";

/**
 * Canonical MCP server shape (stdio or http).
 * Secrets: prefer env var *names* in env map values like "${GITHUB_TOKEN}" — never paste secrets in UI if avoidable.
 * @typedef {object} McpServerDef
 * @property {string} id
 * @property {string} name
 * @property {"stdio"|"http"|"sse"} [transport]
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Record<string,string>} [env]  // values may be ${VAR} references
 * @property {string} [url]
 * @property {Record<string,string>} [headers]
 * @property {boolean} [enabled]
 * @property {string} [notes]
 */

/**
 * @param {string} libraryRoot
 * @returns {Promise<McpServerDef[]>}
 */
export async function listMcpServers(libraryRoot) {
  ensureLibraryDirs(libraryRoot);
  const p = getMcpPath(libraryRoot);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(await fs.readFile(p, "utf-8"));
    return Array.isArray(data.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} libraryRoot
 * @param {McpServerDef[]} servers
 */
async function saveMcpServers(libraryRoot, servers) {
  ensureLibraryDirs(libraryRoot);
  const p = getMcpPath(libraryRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await atomicWriteFile(
    p,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        note:
          "Switchboard Agent Library MCP catalog. Prefer ${ENV_VAR} references for secrets — never store raw API keys here if avoidable.",
        servers,
      },
      null,
      2
    )
  );
}

/**
 * @param {string} libraryRoot
 * @param {Partial<McpServerDef> & { id: string }} def
 */
export async function upsertMcpServer(libraryRoot, def) {
  const id = managedMcpKey(def.id.replace(/^sb-/, "")) || def.id;
  if (!id) throw new Error("Invalid MCP server id");

  const transport = def.transport || (def.url ? "http" : "stdio");
  if (transport === "stdio" && !def.command) {
    throw new Error("stdio MCP server requires command");
  }
  if ((transport === "http" || transport === "sse") && !def.url) {
    throw new Error("http/sse MCP server requires url");
  }

  /** @type {McpServerDef} */
  const entry = {
    id,
    name: def.name || id,
    transport,
    command: def.command || undefined,
    args: Array.isArray(def.args) ? def.args.map(String) : undefined,
    env:
      def.env && typeof def.env === "object"
        ? Object.fromEntries(
            Object.entries(def.env).map(([k, v]) => [k, String(v)])
          )
        : undefined,
    url: def.url || undefined,
    headers:
      def.headers && typeof def.headers === "object"
        ? Object.fromEntries(
            Object.entries(def.headers).map(([k, v]) => [k, String(v)])
          )
        : undefined,
    enabled: def.enabled !== false,
    notes: def.notes || undefined,
  };

  const servers = await listMcpServers(libraryRoot);
  const idx = servers.findIndex((s) => s.id === id);
  if (idx >= 0) servers[idx] = entry;
  else servers.push(entry);
  await saveMcpServers(libraryRoot, servers);
  return entry;
}

/**
 * @param {string} libraryRoot
 * @param {string} id
 */
export async function removeMcpServer(libraryRoot, id) {
  const key = managedMcpKey(id.replace(/^sb-/, "")) || id;
  const servers = await listMcpServers(libraryRoot);
  const next = servers.filter((s) => s.id !== key && s.id !== id);
  await saveMcpServers(libraryRoot, next);
  return { removed: next.length < servers.length };
}
