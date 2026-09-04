// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML, stringifyTOML } from "confbox";
import { replaceCliFiles, snapshotObjectKeys, restoreObjectKeys, writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);

const getCodexDir = () => path.join(os.homedir(), ".codex");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");
const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");
const getBackupPath = () => path.join(getCodexDir(), "switchboard-backup.json");

// Flatten confbox-parsed TOML into a writable object, preserving nested tables
const parsedToWritable = (obj) => obj ?? {};

// Set a nested key from a flat dotted path, creating intermediate objects as needed
const setNestedSection = (obj, dottedKey, value) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
};

// Delete a nested key from a flat dotted path
const deleteNestedSection = (obj, dottedKey) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
};

// Check if codex CLI is installed (via which/where or config file exists)
const checkCodexInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where codex" : "which codex";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getCodexConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current config.toml
const readConfig = async () => {
  try {
    const configPath = getCodexConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Check if config has Switchboard settings
const hasSwitchboardConfig = (config) => {
  if (!config) return false;
  return config.includes("model_provider = \"switchboard\"") || config.includes("[model_providers.switchboard]");
};

// GET - Check codex CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkCodexInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Codex CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasSwitchboard: hasSwitchboardConfig(config),
      configPath: getCodexConfigPath(),
    });
  } catch (error) {
    console.log("Error checking codex settings:", error);
    return NextResponse.json({ error: "Failed to check codex settings" }, { status: 500 });
  }
}

// POST - Update Switchboard settings (merge with existing config)
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { baseUrl, apiKey: rawApiKey, model, subagentModel } = body || {};
    // Local Apply may omit the key (T39): default like the DeepSeek/Gemini/Pi routes.
    const apiKey = rawApiKey || "sk_switchboard";

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const configPath = getCodexConfigPath();
    const authPath = getCodexAuthPath();

    // Ensure directory exists
    await fs.mkdir(codexDir, { recursive: true });

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch { /* No existing config */ }

    // Read existing auth
    let authData = {};
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      authData = JSON.parse(existingAuth);
    } catch { /* No existing auth */ }

    // Snapshot the pre-Apply values once so Disconnect can restore them (T121).
    let backup = {};
    try {
      backup = JSON.parse(await fs.readFile(getBackupPath(), "utf-8"));
    } catch { /* No backup yet */ }
    if (backup?.version !== 1) {
      backup = {
        version: 1,
        root: snapshotObjectKeys(parsed, ["model", "model_provider"]),
        subagent: {
          exists: parsed.agents?.subagent !== undefined,
          value: parsed.agents?.subagent,
        },
        auth: snapshotObjectKeys(authData, ["OPENAI_API_KEY", "auth_mode"]),
      };
      await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });
    }

    // Update only Switchboard related fields (api_key goes to auth.json, not config.toml)
    parsed.model = model;
    parsed.model_provider = "switchboard";

    // Update or create switchboard provider section (no api_key - Codex reads from auth.json)
    // Ensure /v1 suffix is added only once
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    setNestedSection(parsed, "model_providers.switchboard", {
      name: "Switchboard",
      base_url: normalizedBaseUrl,
      wire_api: "responses",
    });

    // Add subagent configuration
    const effectiveSubagentModel = subagentModel || model;
    setNestedSection(parsed, "agents.subagent", {
      model: effectiveSubagentModel,
    });

    // Force apikey mode (keep existing tokens untouched for ChatGPT login reuse)
    authData.OPENAI_API_KEY = apiKey;
    authData.auth_mode = "apikey";

    // Write both files atomically: a later failure restores earlier files (T121).
    await replaceCliFiles([
      { filePath: configPath, content: stringifyTOML(parsed) },
      { filePath: authPath, content: JSON.stringify(authData, null, 2), secret: true },
    ]);

    return NextResponse.json({
      success: true,
      message: "Codex settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error updating codex settings:", error);
    return NextResponse.json({ error: "Failed to update codex settings" }, { status: 500 });
  }
}

// DELETE - Remove Switchboard settings only (keep other settings)
export async function DELETE() {
  try {
    const configPath = getCodexConfigPath();

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No config file to reset",
        });
      }
      throw error;
    }

    // Remove Switchboard related root fields only if they point to switchboard
    const wasSwitchboard = parsed.model_provider === "switchboard";
    if (wasSwitchboard) {
      delete parsed.model;
      delete parsed.model_provider;
    }

    // Remove switchboard provider section
    deleteNestedSection(parsed, "model_providers.switchboard");

    // Remove subagent configuration
    deleteNestedSection(parsed, "agents.subagent");

    // Restore the pre-Apply values captured by POST, if any (T121).
    let backup = {};
    try {
      backup = JSON.parse(await fs.readFile(getBackupPath(), "utf-8"));
    } catch { /* No backup */ }
    if (backup?.version === 1 && wasSwitchboard) {
      restoreObjectKeys(parsed, backup.root);
      if (backup.subagent?.exists) {
        if (parsed.agents == null || typeof parsed.agents !== "object") parsed.agents = {};
        parsed.agents.subagent = backup.subagent.value;
      }
    }

    // Write updated config
    const configContent = stringifyTOML(parsed);
    await writeCliFile(configPath, configContent);

    // Remove OPENAI_API_KEY from auth.json (restoring any pre-existing key)
    const authPath = getCodexAuthPath();
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      const authData = JSON.parse(existingAuth);
      delete authData.OPENAI_API_KEY;
      delete authData.auth_mode;
      if (backup?.version === 1 && wasSwitchboard) restoreObjectKeys(authData, backup.auth);

      // Write back or delete if empty
      if (Object.keys(authData).length === 0) {
        await fs.unlink(authPath);
      } else {
        await writeCliFile(authPath, JSON.stringify(authData, null, 2), { secret: true });
      }
    } catch { /* No auth file */ }

    // Backup consumed: the next Apply must snapshot the current state afresh.
    try { await fs.unlink(getBackupPath()); } catch { /* optional */ }

    return NextResponse.json({
      success: true,
      message: "Switchboard settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting codex settings:", error);
    return NextResponse.json({ error: "Failed to reset codex settings" }, { status: 500 });
  }
}
