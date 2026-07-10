// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml } from "yaml";
import { buildHermesYaml, isNonEmptyString, isOptionalString, normalizeModelIds, removeHermesYaml } from "@/lib/cli/modelCatalog.js";
import { writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "switchboard";
const API_KEY_ENV = "SWITCHBOARD_API_KEY";

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

// Match top-level "model:" block (until next non-indented, non-empty line)
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
  };
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// .env helpers — upsert/remove single KEY=VALUE line
const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${JSON.stringify(String(value))}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

const removeEnvVar = (envText, key) => {
  const re = new RegExp(`^${key}=.*\\r?\\n?`, "m");
  return envText.replace(re, "");
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getHermesConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigYaml = async () => {
  try {
    return await fs.readFile(getHermesConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readEnvFile = async () => {
  try {
    return await fs.readFile(getHermesEnvPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// Detect switchboard by base_url containing localhost/127.0.0.1 or matching tunnel URL
const hasSwitchboardConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(modelCfg.base_url);
};

export async function GET() {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }
    const yaml = await readConfigYaml();
    let parsed = {};
    try { parsed = parseYaml(yaml) || {}; } catch { /* legacy parser below */ }
    const provider = Array.isArray(parsed.custom_providers)
      ? parsed.custom_providers.find((entry) => entry?.name === PROVIDER_NAME)
      : null;
    const catalogModels = provider?.models && typeof provider.models === "object"
      ? Object.keys(provider.models)
      : [];
    const legacyModel = parseModelBlock(yaml);
    const model = provider
      ? { ...(parsed.model || {}), base_url: provider.base_url }
      : legacyModel;
    return NextResponse.json({
      installed: true,
      settings: {
        model,
        models: catalogModels.length ? catalogModels : (model?.default ? [model.default] : []),
        defaultModel: model?.default || null,
      },
      hasSwitchboard: hasSwitchboardConfig(model),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);
    if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const dir = getHermesDir();
    await fs.mkdir(dir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    // Update config.yaml — replace/insert model: block, keep everything else
    const existingYaml = await readConfigYaml();
    const legacyModel = parseModelBlock(existingYaml);
    const baseYaml = hasSwitchboardConfig(legacyModel) ? removeModelBlock(existingYaml) : existingYaml;
    const newYaml = buildHermesYaml(baseYaml, {
      baseUrl: normalizedBaseUrl,
      models,
      defaultModel: defaultModel || model,
    });
    await writeCliFile(getHermesConfigPath(), newYaml);

    // Update .env — upsert OPENAI_API_KEY only when caller provides one
    if (apiKey) {
      const existingEnv = await readEnvFile();
      const newEnv = upsertEnvVar(existingEnv, API_KEY_ENV, apiKey);
      await writeCliFile(getHermesEnvPath(), newEnv, { secret: true });
    }

    return NextResponse.json({
      success: true,
      message: `Hermes configured with ${models.length} model${models.length === 1 ? "" : "s"}.`,
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    let yaml = "";
    try {
      yaml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }
    const managed = yaml.includes("# switchboard-managed-hermes:");
    const legacyModel = managed ? null : parseModelBlock(yaml);
    if (!managed && !hasSwitchboardConfig(legacyModel)) {
      return NextResponse.json({
        success: true,
        message: "Config was not Switchboard-managed; left unchanged",
      });
    }
    const newYaml = managed ? removeHermesYaml(yaml) : removeModelBlock(yaml);
    await writeCliFile(configPath, newYaml);
    try {
      const env = await readEnvFile();
      await writeCliFile(getHermesEnvPath(), removeEnvVar(env, API_KEY_ENV), { secret: true });
    } catch { /* optional env */ }
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} model block removed` });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
