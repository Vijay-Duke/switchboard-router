// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { buildClineSettings, isNonEmptyString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { restoreObjectKeys, snapshotObjectKeys, writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);
const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getSettingsDir = () => path.join(getDataDir(), "settings");
const getProvidersPath = () => path.join(getSettingsDir(), "providers.json");
const getModelsPath = () => path.join(getSettingsDir(), "models.json");
const getLegacyStatePath = () => path.join(getDataDir(), "globalState.json");
const getLegacySecretsPath = () => path.join(getDataDir(), "secrets.json");
const getBackupPath = () => path.join(getDataDir(), "switchboard-backup.json");
const LEGACY_STATE_KEYS = [
  "actModeApiProvider",
  "planModeApiProvider",
  "openAiBaseUrl",
  "actModeOpenAiModelId",
  "planModeOpenAiModelId",
];

const checkInstalled = async () => {
  try {
    await execAsync(os.platform() === "win32" ? "where cline" : "which cline", { windowsHide: true });
    return true;
  } catch {
    for (const file of [getProvidersPath(), getLegacyStatePath()]) {
      try { await fs.access(file); return true; } catch { /* try next */ }
    }
    return false;
  }
};

const readJson = async (filePath) => {
  try { return JSON.parse(await fs.readFile(filePath, "utf-8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    const [providersFile, modelsFile, legacy] = await Promise.all([
      readJson(getProvidersPath()),
      readJson(getModelsPath()),
      readJson(getLegacyStatePath()),
    ]);
    const provider = providersFile?.providers?.switchboard;
    const registry = modelsFile?.providers?.switchboard;
    const models = registry?.models && typeof registry.models === "object" ? Object.keys(registry.models) : [];
    const defaultModel = provider?.defaultModelId || registry?.provider?.defaultModelId || null;
    const legacyBase = legacy?.openAiBaseUrl || null;
    return NextResponse.json({
      installed: true,
      hasSwitchboard: Boolean(provider || registry),
      settings: {
        baseUrl: provider?.baseUrl || registry?.provider?.baseUrl || legacyBase,
        models: models.length ? models : (defaultModel ? [defaultModel] : []),
        model: defaultModel,
        defaultModel,
        actModel: legacy?.actModeOpenAiModelId || defaultModel,
        planModel: legacy?.planModeOpenAiModelId || defaultModel,
      },
      providersPath: getProvidersPath(),
      modelsPath: getModelsPath(),
    });
  } catch (error) {
    console.log("Error checking cline settings:", error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel, actModel, planModel } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl, apiKey, and at least one model are required" }, { status: 400 });
    }
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const [providersFile, modelsFile, legacy, secrets, existingBackup] = await Promise.all([
      readJson(getProvidersPath()),
      readJson(getModelsPath()),
      readJson(getLegacyStatePath()),
      readJson(getLegacySecretsPath()),
      readJson(getBackupPath()),
    ]);
    const next = buildClineSettings({ providers: providersFile, models: modelsFile }, {
      baseUrl: normalizedBaseUrl,
      apiKey,
      models,
      defaultModel: defaultModel || model,
    });
    await fs.mkdir(getSettingsDir(), { recursive: true });
    const backup = existingBackup?.version === 1 ? existingBackup : {
      version: 1,
      state: snapshotObjectKeys(legacy, LEGACY_STATE_KEYS),
      secret: snapshotObjectKeys(secrets, ["openAiApiKey"]),
    };
    backup.managed = { baseUrl: normalizedBaseUrl, apiKey };
    await fs.mkdir(getDataDir(), { recursive: true });
    await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });
    await Promise.all([
      writeCliFile(getProvidersPath(), JSON.stringify(next.providers, null, 2), { secret: true }),
      writeCliFile(getModelsPath(), JSON.stringify(next.models, null, 2)),
    ]);

    // Keep the VS Code extension's Plan/Act settings in sync while current CLI
    // installations read the registry above.
    legacy.actModeApiProvider = "openai";
    legacy.planModeApiProvider = "openai";
    legacy.openAiBaseUrl = normalizedBaseUrl;
    legacy.actModeOpenAiModelId = models.includes(actModel) ? actModel : (defaultModel || model || models[0]);
    legacy.planModeOpenAiModelId = models.includes(planModel) ? planModel : (defaultModel || model || models[0]);
    await writeCliFile(getLegacyStatePath(), JSON.stringify(legacy, null, 2));
    secrets.openAiApiKey = apiKey;
    await writeCliFile(getLegacySecretsPath(), JSON.stringify(secrets, null, 2), { secret: true });

    return NextResponse.json({ success: true, message: `Cline configured with ${models.length} model${models.length === 1 ? "" : "s"}.` });
  } catch (error) {
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const [providersFile, modelsFile] = await Promise.all([readJson(getProvidersPath()), readJson(getModelsPath())]);
    if (providersFile.providers) delete providersFile.providers.switchboard;
    if (modelsFile.providers) delete modelsFile.providers.switchboard;
    await fs.mkdir(getSettingsDir(), { recursive: true });
    await Promise.all([
      writeCliFile(getProvidersPath(), JSON.stringify(providersFile, null, 2), { secret: true }),
      writeCliFile(getModelsPath(), JSON.stringify(modelsFile, null, 2)),
    ]);
    const [legacy, secrets, backup] = await Promise.all([
      readJson(getLegacyStatePath()),
      readJson(getLegacySecretsPath()),
      readJson(getBackupPath()),
    ]);
    if (backup?.version === 1) {
      if (
        legacy.actModeApiProvider === "openai"
        && legacy.planModeApiProvider === "openai"
        && legacy.openAiBaseUrl === backup.managed?.baseUrl
      ) {
        restoreObjectKeys(legacy, backup.state);
        await writeCliFile(getLegacyStatePath(), JSON.stringify(legacy, null, 2));
      }
      if (secrets.openAiApiKey === backup.managed?.apiKey) {
        restoreObjectKeys(secrets, backup.secret);
        await writeCliFile(getLegacySecretsPath(), JSON.stringify(secrets, null, 2), { secret: true });
      }
      try { await fs.unlink(getBackupPath()); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return NextResponse.json({ success: true, message: "Switchboard removed from Cline" });
  } catch (error) {
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: 500 });
  }
}
