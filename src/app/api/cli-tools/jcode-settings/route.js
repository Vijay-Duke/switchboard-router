// @ts-check
"use server";

import { NextResponse } from "next/server";
import { jsonError } from "@/lib/jsonError.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { buildJcodeProvider, isNonEmptyString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

const getProviderEnvPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", "provider-switchboard.env");
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    if (error.code === "ENOENT") return { providers: {} };
    throw error;
  }
};

const hasSwitchboardConfig = (config) => {
  if (!config || !config.providers) return false;

  const providers = config.providers;

  if (providers["switchboard"]) return true;

  for (const [name, provider] of Object.entries(providers)) {
    if (provider.base_url && provider.base_url.includes("localhost:20128")) {
      return true;
    }
  }

  return false;
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await writeCliFile(configPath, content);
};

const readProviderEnv = async () => {
  try {
    const envPath = getProviderEnvPath();
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if (value.startsWith('"') && value.endsWith('"')) {
          try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env) => {
  const envPath = getProviderEnvPath();
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}=${JSON.stringify(String(value))}\n`;
  }

  await writeCliFile(envPath, content, { secret: true });
};

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();
  const hasSwitchboard = hasSwitchboardConfig(config);
  const env = await readProviderEnv();

  return NextResponse.json({
    installed: true,
    config,
    hasSwitchboard,
    configPath: getConfigPath(),
    envApiKey: env.JCODE_SWITCHBOARD_API_KEY || null,
  });
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);

    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(apiKey) || models.length === 0) {
      return NextResponse.json(
        { error: "baseUrl, apiKey, and at least one model are required" },
        { status: 400 }
      );
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

    let config = await readConfig();

    if (!config.providers) {
      config.providers = {};
    }

    config.providers["switchboard"] = buildJcodeProvider({
      baseUrl: normalizedBaseUrl,
      models,
      defaultModel: defaultModel || model,
    });

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    await writeConfig(config);

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const jcodeConfigDir = path.join(xdgConfigDir, "jcode");
    await fs.mkdir(jcodeConfigDir, { recursive: true });

    const env = await readProviderEnv();
    env.JCODE_SWITCHBOARD_API_KEY = apiKey;
    await writeProviderEnv(env);

    return NextResponse.json({
      success: true,
      message: "jcode configured successfully. Use: jcode --provider-profile switchboard",
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.error("Error configuring jcode:", error);
    return jsonError(500, error);
  }
}

export async function DELETE() {
  try {
    const config = await readConfig();

    if (!config.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    delete config.providers["switchboard"];

    await writeConfig(config);

    const env = await readProviderEnv();
    delete env.JCODE_SWITCHBOARD_API_KEY;
    await writeProviderEnv(env);

    return NextResponse.json({
      success: true,
      message: "switchboard configuration removed from jcode",
    });
  } catch (error) {
    console.error("Error removing jcode configuration:", error);
    return jsonError(500, error);
  }
}
