// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { isNonEmptyString, isOptionalString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { restoreObjectKeys, snapshotObjectKeys, writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.primary ?? "";
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");
const getBackupPath = () => path.join(getOpenClawDir(), "switchboard-backup.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getOpenClawSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getOpenClawSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Check if settings has Switchboard config
const hasSwitchboardConfig = (settings) => {
  if (!settings || !settings.models || !settings.models.providers) return false;
  return !!settings.models.providers["switchboard"];
};

// Read per-agent models.json and return current model id (without "switchboard/" prefix)
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    const data = JSON.parse(content);
    const models = data?.providers?.["switchboard"]?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
      })
    );

    return NextResponse.json({
      installed: true,
      settings,
      agents: enrichedAgents,
      hasSwitchboard: hasSwitchboardConfig(settings),
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// Write per-agent models.json
const readAgentModels = async (agentDir) => {
  const modelsPath = path.join(agentDir, "models.json");
  try { return JSON.parse(await fs.readFile(modelsPath, "utf-8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
};

const writeAgentModels = async (agentDir, models, baseUrl, apiKey) => {
  await fs.mkdir(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  const existing = await readAgentModels(agentDir);

  if (!existing.providers) existing.providers = {};
  existing.providers["switchboard"] = {
    baseUrl,
    apiKey: apiKey || "your_api_key",
    api: "openai-completions",
    models: normalizeModelIds(models).map((model) => ({ id: model, name: model.split("/").pop() || model })),
  };
  await writeCliFile(modelsPath, JSON.stringify(existing, null, 2), { secret: true });
};

// POST - Update Switchboard settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel, agentModels = {} } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);
    const activeModel = models.includes(defaultModel || model) ? (defaultModel || model) : models[0];
    
    if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    await fs.mkdir(openclawDir, { recursive: true });

    let settings = {};
    try {
      const existingSettings = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(existingSettings);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const backup = await (async () => {
      try { return JSON.parse(await fs.readFile(getBackupPath(), "utf-8")); }
      catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
    })();
    if (backup.version !== 1) {
      backup.version = 1;
      backup.mainProvider = snapshotObjectKeys(settings.models?.providers || {}, ["switchboard"]);
      backup.defaultPrimary = snapshotObjectKeys(settings.agents?.defaults?.model || {}, ["primary"]);
      backup.defaultModels = Object.fromEntries(
        Object.entries(settings.agents?.defaults?.models || {}).filter(([key]) => key.startsWith("switchboard/")),
      );
      backup.agents = {};
      backup.agentProviders = {};
    }
    backup.agents ||= {};
    backup.agentProviders ||= {};

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const fullModelId = `switchboard/${activeModel}`;

    // Remove all old switchboard/* entries from agents.defaults.models
    Object.keys(settings.agents.defaults.models)
      .filter((k) => k.startsWith("switchboard/"))
      .forEach((k) => { delete settings.agents.defaults.models[k]; });

    // Update default model
    settings.agents.defaults.model.primary = fullModelId;

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set(models);
    const normalizedAgentModels = Object.fromEntries(
      Object.entries(agentModels).flatMap(([agentId, value]) => {
        const [normalized] = normalizeModelIds(value);
        return normalized ? [[agentId, normalized]] : [];
      }),
    );
    Object.values(normalizedAgentModels).forEach((modelId) => allModelIds.add(modelId));

    // Add fresh switchboard models to allowlist
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`switchboard/${m}`] = {};
    });

    // Remove old switchboard model from each agent in agents.list. The
    // model field may be a plain string or `{ primary, fallbacks }`.
    if (Array.isArray(settings.agents.list)) {
      for (const agent of settings.agents.list) {
        if (!Object.hasOwn(backup.agents, agent.id)) {
          backup.agents[agent.id] = snapshotObjectKeys(agent, ["model"]).model;
        }
        if (agent.agentDir && !Object.hasOwn(backup.agentProviders, agent.agentDir)) {
          const agentFile = await readAgentModels(agent.agentDir);
          backup.agentProviders[agent.agentDir] = snapshotObjectKeys(agentFile.providers || {}, ["switchboard"]).switchboard;
        }
      }
      settings.agents.list = settings.agents.list.map((agent) => {
        if (resolveAgentModel(agent.model).startsWith("switchboard/")) {
          const { model: _, ...rest } = agent;
          return rest;
        }
        return agent;
      });
    }
    await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });

    // Update models.providers.switchboard with all models
    settings.models.providers["switchboard"] = {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "your_api_key",
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };

    // Set per-agent model in agents.list and write models.json
    if (Array.isArray(settings.agents.list)) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = normalizedAgentModels[agent.id];
        if (agentModel) return { ...agent, model: `switchboard/${agentModel}` };
        return agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(
        settings.agents.list.map(async (agent) => {
          if (!agent.agentDir) return;
          const agentModel = normalizedAgentModels[agent.id] || activeModel;
          await writeAgentModels(
            agent.agentDir,
            [agentModel, ...allModelIds],
            normalizedBaseUrl,
            apiKey,
          );
        })
      );
    }

    await writeCliFile(settingsPath, JSON.stringify(settings, null, 2), { secret: true });

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating openclaw settings:", error);
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 });
  }
}

// DELETE - Remove Switchboard settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Read existing settings
    let settings = {};
    try {
      const existingSettings = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(existingSettings);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    let backup = {};
    try { backup = JSON.parse(await fs.readFile(getBackupPath(), "utf-8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }

    // Remove Switchboard from models.providers
    if (settings.models && settings.models.providers) {
      if (backup.version === 1) restoreObjectKeys(settings.models.providers, backup.mainProvider);
      else delete settings.models.providers["switchboard"];
      
      // Remove providers object if empty
      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove switchboard models from agents.defaults.models allowlist
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) => k.startsWith("switchboard/"));
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (backup.version === 1) Object.assign(settings.agents.defaults.models, backup.defaultModels || {});
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it uses switchboard
    if (settings.agents?.defaults?.model?.primary?.startsWith("switchboard/")) {
      if (backup.version === 1) restoreObjectKeys(settings.agents.defaults.model, backup.defaultPrimary);
      else delete settings.agents.defaults.model.primary;
    }

    if (Array.isArray(settings.agents?.list)) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (!resolveAgentModel(agent.model).startsWith("switchboard/")) return agent;
        const snapshot = backup.version === 1 ? backup.agents?.[agent.id] : null;
        if (snapshot?.exists) return { ...agent, model: snapshot.value };
        const { model: _, ...rest } = agent;
        return rest;
      });
    }
    const agentDirs = new Set([
      ...(settings.agents?.list || []).map((agent) => agent.agentDir).filter(Boolean),
      ...Object.keys(backup.agentProviders || {}),
    ]);
    await Promise.all([...agentDirs].map(async (agentDir) => {
      const agentFile = await readAgentModels(agentDir);
      if (!agentFile.providers?.switchboard) return;
      if (backup.version === 1) {
        restoreObjectKeys(agentFile.providers, { switchboard: backup.agentProviders?.[agentDir] });
      } else {
        delete agentFile.providers.switchboard;
      }
      if (Object.keys(agentFile.providers || {}).length === 0) delete agentFile.providers;
      await writeCliFile(path.join(agentDir, "models.json"), JSON.stringify(agentFile, null, 2), { secret: true });
    }));

    // Write updated settings
    await writeCliFile(settingsPath, JSON.stringify(settings, null, 2), { secret: true });
    try { await fs.unlink(getBackupPath()); } catch (error) { if (error?.code !== "ENOENT") throw error; }

    return NextResponse.json({
      success: true,
      message: "Switchboard settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting openclaw settings:", error);
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 });
  }
}
