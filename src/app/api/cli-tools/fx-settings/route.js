// @ts-check
"use server";

/**
 * FX CLI (fx.sh) — custom OpenAI-compatible connection via ~/.fx/settings.json
 * Effort/thinking: FX adapter does not send reasoning_effort; expose effort as
 * distinct model IDs with Switchboard suffix form model(level).
 */
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/jsonError.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  isNonEmptyString,
  isOptionalString,
  mergeFxSwitchboardSettings,
  normalizeModelIds,
  resolveDefaultModel,
} from "@/lib/cli/modelCatalog.js";
import { buildPiCapsResolver, normalizeBaseUrl } from "@/lib/cli/piCatalogSync.js";
import {
  replaceCliFiles,
  restoreObjectKeys,
  snapshotObjectKeys,
} from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);
const PROVIDER_ID = "switchboard";
const BACKUP_VERSION = 1;

const getFxDir = () => path.join(os.homedir(), ".fx");
const getSettingsPath = () => path.join(getFxDir(), "settings.json");
const getBackupPath = () => path.join(getFxDir(), "switchboard-backup.json");

const isLocalBase = (url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));

const checkInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    await execAsync(isWindows ? "where fx" : "which fx", { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getFxDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const validateBackup = (backup) => {
  if (backup == null) return null;
  if (backup.version === BACKUP_VERSION && backup.state === "restored") return backup;
  if (backup.version !== BACKUP_VERSION
    || !backup.settings
    || !backup.managedSettings) {
    throw new Error("Unsupported or invalid FX Switchboard backup file");
  }
  return backup;
};

const hasSwitchboardProvider = (settings) => {
  const provider = settings?.providers?.[PROVIDER_ID];
  if (!provider?.base_url) return false;
  return isLocalBase(provider.base_url);
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "FX is not installed. See https://fx.sh/docs",
      });
    }

    const settings = (await readJson(getSettingsPath())) || {};
    const provider = settings.providers?.[PROVIDER_ID] || null;
    const models = provider?.model_metadata
      ? Object.keys(provider.model_metadata).filter((id) => !/\([^()]+\)$/.test(id))
      : [];
    const configuredDefault = settings.provider === PROVIDER_ID
      ? settings.models?.[PROVIDER_ID]
      : null;
    const model = configuredDefault || models[0] || null;

    return NextResponse.json({
      installed: true,
      hasSwitchboard: hasSwitchboardProvider(settings),
      settings: {
        baseUrl: provider?.base_url || null,
        model,
        defaultModel: model,
        models,
        apiKeySet: provider?.auth?.env === "FX_SWITCHBOARD_API_KEY",
        provider: PROVIDER_ID,
      },
      configPath: getSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking fx settings:", error);
    return NextResponse.json({ error: "Failed to check fx settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const {
      baseUrl,
      apiKey,
      model,
      models: requestedModels,
      defaultModel,
    } = body || {};
    const models = normalizeModelIds(requestedModels ?? model);
    if (!isNonEmptyString(baseUrl)
      || !isOptionalString(apiKey)
      || models.length === 0) {
      return NextResponse.json({
        error: "baseUrl, models, and API key are required",
      }, { status: 400 });
    }

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";
    const activeModel = resolveDefaultModel(defaultModel || model, models);
    const capsResolver = await buildPiCapsResolver();

    await fs.mkdir(getFxDir(), { recursive: true, mode: 0o700 });

    const existing = (await readJson(getSettingsPath())) || {};
    const rawBackup = await readJson(getBackupPath());
    const validatedBackup = validateBackup(rawBackup);
    const storedBackup = validatedBackup?.state === "restored" ? null : validatedBackup;

    const backup = storedBackup?.version === BACKUP_VERSION
      ? storedBackup
      : {
          version: BACKUP_VERSION,
          state: "active",
          settings: snapshotObjectKeys(existing, ["provider", "providers", "models"]),
        };

    const next = mergeFxSwitchboardSettings(existing, {
      baseUrl: normalized,
      models,
      defaultModel: activeModel,
      capsResolver,
    });

    backup.managedSettings = snapshotObjectKeys(next, ["provider", "providers", "models"]);
    backup.managedProvider = next.providers?.[PROVIDER_ID];

    await replaceCliFiles([
      { filePath: getSettingsPath(), content: `${JSON.stringify(next, null, 2)}\n`, secret: true },
      { filePath: getBackupPath(), content: `${JSON.stringify(backup, null, 2)}\n`, secret: true },
    ]);

    void key; // FX reads FX_SWITCHBOARD_API_KEY from the environment

    return NextResponse.json({
      success: true,
      message: `FX configured with ${models.length} base model${models.length === 1 ? "" : "s"}. Pick effort-specific IDs like alias/model(max) — fx --effort does not reach Switchboard.`,
      configPath: getSettingsPath(),
    });
  } catch (error) {
    console.error("Error configuring fx:", error);
    return jsonError(500, error);
  }
}

export async function DELETE() {
  try {
    const rawBackup = await readJson(getBackupPath());
    const backup = validateBackup(rawBackup);
    if (backup?.state === "restored") {
      return NextResponse.json({ success: true, message: "No Switchboard FX settings to reset" });
    }

    const existingFile = await readJson(getSettingsPath());
    const settings = existingFile ? { ...existingFile } : {};
    if (!backup && existingFile === null) {
      return NextResponse.json({ success: true, message: "No Switchboard FX settings to reset" });
    }

    if (backup) {
      for (const key of ["provider", "providers", "models"]) {
        if (sameJson(settings[key], backup.managedSettings?.[key])) {
          restoreObjectKeys(settings, { [key]: backup.settings?.[key] });
        }
      }
    } else {
      delete settings.providers?.[PROVIDER_ID];
      if (settings.provider === PROVIDER_ID) delete settings.provider;
      delete settings.models?.[PROVIDER_ID];
    }

    await replaceCliFiles([
      {
        filePath: getBackupPath(),
        content: JSON.stringify({ version: BACKUP_VERSION, state: "restored" }, null, 2),
        secret: true,
      },
      {
        filePath: getSettingsPath(),
        content: `${JSON.stringify(settings, null, 2)}\n`,
        secret: true,
      },
    ]);

    return NextResponse.json({
      success: true,
      message: "Switchboard FX settings reset and previous values restored",
    });
  } catch (error) {
    console.error("Error removing fx configuration:", error);
    return jsonError(500, error);
  }
}
