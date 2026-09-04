// @ts-check
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseYAML, parseJSON } from "confbox";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
  setModelAlias,
  createCombo,
  getComboByName,
  updateCombo,
  createApiKey,
  getApiKeys,
  getSettings,
  updateSettings,
} from "@/lib/db/index.js";
import { getDataDir } from "@/lib/db/paths.js";
import { getConsistentMachineId } from "@/shared/utils/machineId.js";
import * as log from "@/sse/utils/logger.js";

/**
 * Parses raw YAML/JSON/JSONC content into an object.
 * @param {string} content
 * @returns {object}
 */
export function parseConfigContent(content) {
  if (!content || typeof content !== "string") return {};
  const trimmed = content.trim();
  if (!trimmed) return {};

  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseJSON(trimmed) || {};
    }
    return parseYAML(trimmed) || {};
  } catch {
    try {
      return parseYAML(trimmed) || {};
    } catch (err) {
      log.warn("CONFIG_IMPORT", "Failed to parse config content", { error: err?.message });
      return {};
    }
  }
}

/**
 * Import a configuration object into SQLite database.
 * Supports connections, model aliases, combos, api keys, and settings.
 *
 * @param {object|string} configOrContent
 * @returns {Promise<{ connections: number, aliases: number, combos: number, keys: number, settings: boolean }>}
 */
export async function importConfig(configOrContent) {
  const config = typeof configOrContent === "string"
    ? parseConfigContent(configOrContent)
    : configOrContent || {};

  const stats = { connections: 0, aliases: 0, combos: 0, keys: 0, settings: false };

  // 1. Provider Connections
  const connections = config.connections || config.providers || [];
  if (Array.isArray(connections)) {
    const existing = await getProviderConnections();
    for (const conn of connections) {
      if (!conn || typeof conn !== "object" || !conn.provider) continue;
      const provider = String(conn.provider).toLowerCase();
      const existingMatch = existing.find(
        (e) => e.provider === provider && (e.name === conn.name || (conn.apiKey && e.apiKey === conn.apiKey))
      );

      if (existingMatch) {
        await updateProviderConnection(existingMatch.id, {
          apiKey: conn.apiKey || conn.key || existingMatch.apiKey,
          accessToken: conn.accessToken || existingMatch.accessToken,
          refreshToken: conn.refreshToken || existingMatch.refreshToken,
          isActive: conn.isActive !== undefined ? conn.isActive : existingMatch.isActive,
          priority: conn.priority !== undefined ? conn.priority : existingMatch.priority,
          providerSpecificData: { ...(existingMatch.providerSpecificData || {}), ...(conn.providerSpecificData || {}) },
        });
      } else {
        await createProviderConnection({
          provider,
          name: conn.name || `${provider}-config`,
          authType: conn.authType || (conn.refreshToken ? "oauth" : "apikey"),
          apiKey: conn.apiKey || conn.key || "",
          accessToken: conn.accessToken || "",
          refreshToken: conn.refreshToken || "",
          isActive: conn.isActive !== undefined ? Boolean(conn.isActive) : true,
          priority: typeof conn.priority === "number" ? conn.priority : 0,
          providerSpecificData: conn.providerSpecificData || {},
        });
      }
      stats.connections++;
    }
  }

  // 2. Model Aliases (exact and wildcard glob patterns)
  const aliases = config.model_aliases || config.aliases || config.modelAliases || {};
  if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
    for (const [alias, target] of Object.entries(aliases)) {
      if (typeof alias === "string" && typeof target === "string") {
        await setModelAlias(alias.trim(), target.trim());
        stats.aliases++;
      }
    }
  }

  // 3. Combos
  const combos = config.combos || [];
  if (Array.isArray(combos)) {
    for (const combo of combos) {
      if (!combo || !combo.name || !Array.isArray(combo.models)) continue;
      const name = String(combo.name).trim();
      const existing = await getComboByName(name);
      if (existing) {
        await updateCombo(existing.id, {
          models: combo.models,
          description: combo.description || existing.description,
        });
      } else {
        await createCombo({
          name,
          models: combo.models,
          description: combo.description || "",
        });
      }
      stats.combos++;
    }
  }

  // 4. API Keys (Client Keys)
  const apiKeys = config.api_keys || config.client_keys || config.apiKeys || [];
  if (Array.isArray(apiKeys) && apiKeys.length > 0) {
    const existing = await getApiKeys();
    const machineId = await getConsistentMachineId();
    for (const keyDef of apiKeys) {
      if (!keyDef || !keyDef.name) continue;
      const name = String(keyDef.name).trim();
      const existingMatch = existing.find((k) => k.name === name);
      if (!existingMatch) {
        await createApiKey(name, machineId);
        stats.keys++;
      }
    }
  }

  // 5. Settings — allowlisted to keys the settings store already knows.
  // Unknown keys (typos, stale or attacker-planted entries) are ignored, so a
  // dropped config file cannot overwrite arbitrary settings.
  const settings = config.settings || {};
  if (settings && typeof settings === "object" && Object.keys(settings).length > 0) {
    const current = await getSettings();
    const allowed = new Set(Object.keys(current));
    const filtered = {};
    for (const [key, value] of Object.entries(settings)) {
      if (allowed.has(key)) {
        filtered[key] = value;
      } else {
        log.warn("CONFIG_IMPORT", `Ignoring unknown settings key: ${key}`);
      }
    }
    if (Object.keys(filtered).length > 0) {
      await updateSettings({ ...current, ...filtered });
      stats.settings = true;
    }
  }

  return stats;
}

const IMPORT_STATE_FILE = "config-import-state.json";

function getImportStatePath() {
  return path.join(getDataDir(), IMPORT_STATE_FILE);
}

function readImportState() {
  try {
    if (!fs.existsSync(getImportStatePath())) return {};
    return JSON.parse(fs.readFileSync(getImportStatePath(), "utf-8")) || {};
  } catch {
    return {};
  }
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function markImported(filePath, hash) {
  try {
    const state = readImportState();
    state[path.resolve(filePath)] = { hash, at: new Date().toISOString() };
    fs.writeFileSync(getImportStatePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn("CONFIG_IMPORT", "Failed to record config import state", { error: err?.message });
  }
}

/**
 * Whether this exact file content was already auto-imported. Auto-import is
 * checksum-gated so a stale config file is not re-applied on every boot
 * (which would clobber settings the user changed via the dashboard). Editing
 * the file changes the hash and re-arms the import.
 */
export function wasAlreadyImported(filePath, content) {
  const state = readImportState();
  const entry = state[path.resolve(filePath)];
  return !!entry && entry.hash === hashContent(content);
}

/**
 * Automatically import config on server startup if an import file is specified
 * via CONFIG_FILE, IMPORT_CONFIG_FILE, or found at ~/.switchboard/config.yaml / .json.
 */
export async function autoImportConfigFile() {
  const envPath = process.env.IMPORT_CONFIG_FILE || process.env.CONFIG_FILE || process.env.SWITCHBOARD_CONFIG_FILE;
  const candidatePaths = envPath
    ? [envPath]
    : [
        path.join(getDataDir(), "config.yaml"),
        path.join(getDataDir(), "config.yml"),
        path.join(getDataDir(), "config.json"),
      ];

  for (const filePath of candidatePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        if (wasAlreadyImported(filePath, content)) {
          log.info("CONFIG_IMPORT", `Skipping already-imported configuration at ${filePath}`);
          return null;
        }
        log.info("CONFIG_IMPORT", `Auto-importing configuration from ${filePath}`);
        const stats = await importConfig(content);
        markImported(filePath, hashContent(content));
        log.info("CONFIG_IMPORT", "Configuration imported successfully", stats);
        return stats;
      }
    } catch (err) {
      log.warn("CONFIG_IMPORT", `Failed to auto-import config from ${filePath}`, { error: err?.message });
    }
  }
  return null;
}
