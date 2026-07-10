// @ts-check
"use server";

/**
 * Google Gemini CLI — native Gemini protocol via ~/.gemini/.env.
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { buildGeminiSettings, isNonEmptyString, isOptionalString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { restoreObjectKeys, snapshotObjectKeys, writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);

const getGeminiDir = () => path.join(os.homedir(), ".gemini");
const getEnvPath = () => path.join(getGeminiDir(), ".env");
const getSettingsPath = () => path.join(getGeminiDir(), "settings.json");
const getBackupPath = () => path.join(getGeminiDir(), "switchboard-backup.json");
const ENV_START = "# switchboard-managed:start";
const ENV_END = "# switchboard-managed:end";

const normalizeBaseUrl = (baseUrl) => String(baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");

const isLocalBase = (url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    // Binary may be `gemini` or `gemini-cli`
    for (const bin of ["gemini", "gemini-cli"]) {
      try {
        await execAsync(isWindows ? `where ${bin}` : `which ${bin}`, { windowsHide: true });
        return true;
      } catch {
        /* try next */
      }
    }
    await fs.access(getGeminiDir());
    return true;
  } catch {
    return false;
  }
};

const parseEnvFile = async () => {
  try {
    const raw = await fs.readFile(getEnvPath(), "utf-8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const body = t.startsWith("export ") ? t.slice(7) : t;
      const eq = body.indexOf("=");
      if (eq < 1) continue;
      let v = body.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[body.slice(0, eq).trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
};

const stripManagedEnv = (text) => String(text || "")
  .replace(new RegExp(`${ENV_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${ENV_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`, "g"), "")
  .trimEnd();

const writeManagedEnv = (text, values) => {
  const existing = stripManagedEnv(text);
  const block = [
    ENV_START,
    ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ENV_END,
  ].join("\n");
  return `${existing ? `${existing}\n\n` : ""}${block}\n`;
};

const readSettings = async () => {
  try { return JSON.parse(await fs.readFile(getSettingsPath(), "utf-8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};

const readBackup = async () => {
  try { return JSON.parse(await fs.readFile(getBackupPath(), "utf-8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Gemini CLI is not installed",
      });
    }

    const env = await parseEnvFile();
    const baseUrl = env.GOOGLE_GEMINI_BASE_URL || null;
    const model = env.GEMINI_MODEL || null;
    const settings = await readSettings();
    const models = settings?.modelConfigs?.modelDefinitions && typeof settings.modelConfigs.modelDefinitions === "object"
      ? Object.entries(settings.modelConfigs.modelDefinitions)
        .filter(([, entry]) => entry?.family === "switchboard")
        .map(([id]) => id)
      : [];
    const hasSwitchboard = !!(baseUrl && isLocalBase(baseUrl));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        models: models.length ? models : (model ? [model] : []),
        defaultModel: model,
        apiKeySet: !!env.GEMINI_API_KEY,
      },
      configPath: getEnvPath(),
      settingsPath: getSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking gemini-cli settings:", error);
    return NextResponse.json({ error: "Failed to check gemini-cli settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);
    if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    await fs.mkdir(getGeminiDir(), { recursive: true });
    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";

    let existingEnv = "";
    try { existingEnv = await fs.readFile(getEnvPath(), "utf-8"); } catch { /* new file */ }
    const activeModel = models.includes(defaultModel || model) ? (defaultModel || model) : models[0];
    const envBody = writeManagedEnv(existingEnv, {
      GEMINI_API_KEY: key,
      GEMINI_MODEL: activeModel,
      GOOGLE_GEMINI_BASE_URL: normalized,
    });
    let previousSettings = null;
    try { previousSettings = await fs.readFile(getSettingsPath(), "utf-8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const currentSettings = previousSettings === null ? {} : JSON.parse(previousSettings);
    const definitions = currentSettings?.modelConfigs?.modelDefinitions || {};
    const existingBackup = await readBackup();
    const backup = existingBackup.version === 1 ? existingBackup : {
      version: 1,
      modelName: snapshotObjectKeys(currentSettings.model || {}, ["name"]).name,
      dynamicModelConfiguration: snapshotObjectKeys(
        currentSettings.experimental || {},
        ["dynamicModelConfiguration"],
      ).dynamicModelConfiguration,
      switchboardDefinitions: Object.fromEntries(
        Object.entries(definitions).filter(([, entry]) => entry?.family === "switchboard"),
      ),
    };
    const settings = buildGeminiSettings(currentSettings, { models, defaultModel: activeModel });
    // Validate both inputs before mutating either file. Each replacement is
    // atomic, so a crash cannot leave a truncated environment or catalog.
    await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });
    await writeCliFile(getSettingsPath(), JSON.stringify(settings, null, 2));
    try {
      await writeCliFile(getEnvPath(), envBody, { secret: true });
    } catch (error) {
      if (previousSettings === null) await fs.unlink(getSettingsPath());
      else await writeCliFile(getSettingsPath(), previousSettings);
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: `Gemini CLI configured with ${models.length} model${models.length === 1 ? "" : "s"}.`,
      configPath: getEnvPath(),
    });
  } catch (error) {
    console.log("Error updating gemini-cli settings:", error);
    return NextResponse.json({ error: "Failed to update gemini-cli settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    try {
      const env = await fs.readFile(getEnvPath(), "utf-8");
      const cleaned = stripManagedEnv(env);
      if (cleaned) await writeCliFile(getEnvPath(), `${cleaned}\n`, { secret: true });
      else await fs.unlink(getEnvPath());
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    try {
      const settings = JSON.parse(await fs.readFile(getSettingsPath(), "utf-8"));
      const backup = await readBackup();
      const definitions = settings?.modelConfigs?.modelDefinitions && typeof settings.modelConfigs.modelDefinitions === "object"
        ? settings.modelConfigs.modelDefinitions
        : {};
      const switchboardNames = new Set(Object.entries(definitions).filter(([, entry]) => entry?.family === "switchboard").map(([id]) => id));
      const remainingDefinitions = Object.fromEntries(Object.entries(definitions).filter(([, entry]) => entry?.family !== "switchboard"));
      Object.assign(remainingDefinitions, backup.switchboardDefinitions || {});
      if (!settings.modelConfigs || typeof settings.modelConfigs !== "object") settings.modelConfigs = {};
      settings.modelConfigs.modelDefinitions = remainingDefinitions;
      if (switchboardNames.has(settings?.model?.name)) {
        if (!settings.model || typeof settings.model !== "object") settings.model = {};
        restoreObjectKeys(settings.model, { name: backup.modelName });
      }
      if (Object.keys(settings.modelConfigs.modelDefinitions).length === 0) delete settings.modelConfigs.modelDefinitions;
      if (Object.keys(settings.modelConfigs).length === 0) delete settings.modelConfigs;
      if (settings.experimental?.dynamicModelConfiguration === true) {
        restoreObjectKeys(settings.experimental, {
          dynamicModelConfiguration: backup.dynamicModelConfiguration,
        });
        if (Object.keys(settings.experimental).length === 0) delete settings.experimental;
      }
      await writeCliFile(getSettingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    try { await fs.unlink(getBackupPath()); } catch (e) { if (e?.code !== "ENOENT") throw e; }
    return NextResponse.json({ success: true, message: "Switchboard Gemini env removed" });
  } catch (error) {
    console.log("Error resetting gemini-cli settings:", error);
    return NextResponse.json({ error: "Failed to reset gemini-cli settings" }, { status: 500 });
  }
}
