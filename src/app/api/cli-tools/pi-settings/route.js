// @ts-check
"use server";

/**
 * Pi coding agent (@earendil-works/pi-coding-agent / omp)
 * Custom OpenAI-compatible provider via ~/.pi/agent/models.yml with live
 * model discovery (omp >= v18 reads models.yml; plain pi still reads
 * models.json, so both stay in sync).
 * docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildPiModelEntries,
  isNonEmptyString,
  isOptionalString,
  normalizeModelIds,
  resolveDefaultModel,
} from "@/lib/cli/modelCatalog.js";
import { replaceCliFiles, restoreObjectKeys, snapshotObjectKeys } from "@/lib/cli/fileIo.js";
import { normalizeClaudeCatalogPickerLabels } from "@/shared/claudeGateway.js";

const execAsync = promisify(exec);

const PROVIDER_ID = "switchboard";
const BACKUP_VERSION = 1;

// Pi stores the provider catalog, settings, and Switchboard backup in three
// separate files. Serialize mutations in this process so two dashboard clicks
// cannot read the same snapshot and publish a mixed configuration.
let mutationTail = Promise.resolve();

const withMutationLock = (operation) => {
  const next = mutationTail.then(operation, operation);
  mutationTail = next.catch(() => {});
  return next;
};

const getAgentDir = () => path.join(os.homedir(), ".pi", "agent");
const getModelsPath = () => path.join(getAgentDir(), "models.json");
const getSettingsPath = () => path.join(getAgentDir(), "settings.json");
const getBackupPath = () => path.join(getAgentDir(), "switchboard-backup.json");
// omp (Pi >= v18) reads models.yml and ignores models.json; plain pi still
// reads models.json. Both are written so every Pi variant sees the provider.
const getModelsYmlPath = () => path.join(getAgentDir(), "models.yml");

const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

const isLocalBase = (url) => {
  try {
    const hostname = new URL(String(url || "")).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "0.0.0.0"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
};

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    await execAsync(isWindows ? "where pi" : "which pi", { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getAgentDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readJsonFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`${filePath} must contain a JSON object`);
    }
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

const readModels = () => readJsonFile(getModelsPath(), { providers: {} });
const readSettings = () => readJsonFile(getSettingsPath(), {});
const readBackup = () => readJsonFile(getBackupPath(), null);

const readYamlFile = async (filePath, fallback) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = raw.trim() === "" ? {} : parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`${filePath} must contain a YAML object`);
    }
    return parsed;
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

const readModelsYml = () => readYamlFile(getModelsYmlPath(), { providers: {} });

const canonicalModelIds = (models) => models.map((model) => `${PROVIDER_ID}/${model}`);

/** Keep other providers visible. A switchboard-only whitelist is lifted. */
const mergeEnabledModels = (existing, switchboardIds) => {
  if (!Array.isArray(existing) || existing.length === 0) return undefined;
  const others = existing.filter((id) => typeof id !== "string" || !id.startsWith(`${PROVIDER_ID}/`));
  if (others.length === 0) return undefined;
  return [...others, ...switchboardIds];
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const sameJson = (left, right) => (
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
);

const isSnapshot = (value) => value && typeof value === "object" && typeof value.exists === "boolean";

const validateBackup = (backup) => {
  if (backup == null) return null;
  if (backup.version === BACKUP_VERSION && backup.state === "restored") return backup;
  const settingKeys = ["defaultProvider", "defaultModel", "enabledModels"];
  if (backup.version !== BACKUP_VERSION
    || !isSnapshot(backup.provider)
    || !settingKeys.every((key) => isSnapshot(backup.settings?.[key]))
    || !backup.managedProvider
    || !backup.managedSettings) {
    throw new Error("Unsupported or invalid Pi Switchboard backup file");
  }
  return backup;
};

const writePiState = async (modelsYml, models, settings, backup) => {
  await fs.mkdir(getAgentDir(), { recursive: true });
  await replaceCliFiles([
    {
      filePath: getBackupPath(),
      content: backup ? JSON.stringify(backup, null, 2) : null,
      secret: true,
    },
    // Writing models.yml also bumps its mtime, which makes omp treat its
    // discovery cache as older than the config and refetch /v1/models.
    { filePath: getModelsYmlPath(), content: stringifyYaml(modelsYml), secret: true },
    { filePath: getModelsPath(), content: JSON.stringify(models, null, 2), secret: true },
    { filePath: getSettingsPath(), content: JSON.stringify(settings, null, 2), secret: true },
  ]);
};

const restoreManagedSetting = (settings, backup, key) => {
  // defaultModel is only owned by Switchboard while its provider is active.
  // A user can switch providers without changing the model id, so comparing
  // the id alone is not sufficient to prove that Switchboard still owns it.
  if ((key === "defaultProvider" || key === "defaultModel")
    && settings.defaultProvider !== PROVIDER_ID) return;
  if (sameJson(settings[key], backup?.managedSettings?.[key])) {
    restoreObjectKeys(settings, { [key]: backup.settings?.[key] });
  }
};

async function getPiSettings() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Pi is not installed",
      });
    }

    const [ymlData, data, piSettings] = await Promise.all([
      readModelsYml(),
      readModels(),
      readSettings(),
    ]);
    // models.yml is canonical for omp; fall back to models.json for plain
    // pi setups and legacy installs that predate the migration.
    const ymlProvider = ymlData?.providers?.[PROVIDER_ID] || null;
    const provider = ymlProvider || data?.providers?.[PROVIDER_ID] || null;
    const staticEntries = Array.isArray(ymlProvider?.models)
      ? ymlProvider.models
      : (Array.isArray(data?.providers?.[PROVIDER_ID]?.models)
        ? data.providers[PROVIDER_ID].models
        : []);
    const models = staticEntries.map((entry) => entry?.id).filter(Boolean);
    const pickerLabels = Object.fromEntries(
      staticEntries
        .filter((entry) => entry?.id && entry?.name)
        .map((entry) => [entry.id, entry.name]),
    );
    const configuredDefault = piSettings.defaultProvider === PROVIDER_ID
      && models.includes(piSettings.defaultModel)
      ? piSettings.defaultModel
      : null;
    const model = configuredDefault || models[0] || null;
    const baseUrl = provider?.baseUrl || null;
    const hasSwitchboard = !!(provider && isLocalBase(baseUrl));
    const scopeConfigured = hasSwitchboard && models.length > 0;

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        defaultModel: model,
        models,
        pickerLabels,
        apiKeySet: !!provider?.apiKey,
        provider: PROVIDER_ID,
        scopeConfigured,
      },
      configPath: getModelsYmlPath(),
      settingsPath: getSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json({ error: "Failed to check pi settings" }, { status: 500 });
  }
}

export async function GET() {
  return withMutationLock(getPiSettings);
}

async function postPiSettings(request) {
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
      pickerLabels: requestedPickerLabels,
    } = body || {};
    const [ymlData, data, piSettings, rawBackup] = await Promise.all([
      readModelsYml(),
      readModels(),
      readSettings(),
      readBackup(),
    ]);
    const validatedBackup = validateBackup(rawBackup);
    const storedBackup = validatedBackup?.state === "restored" ? null : validatedBackup;
    const previousModels = Array.isArray(ymlData?.providers?.[PROVIDER_ID]?.models)
      ? ymlData.providers[PROVIDER_ID].models
      : (Array.isArray(data?.providers?.[PROVIDER_ID]?.models)
        ? data.providers[PROVIDER_ID].models
        : []);
    const legacyModels = requestedModels === undefined
      ? [model, ...previousModels.map((entry) => entry?.id)]
      : requestedModels;
    const models = normalizeModelIds(legacyModels);
    const pickerLabelsValid = requestedPickerLabels === undefined
      || (
        requestedPickerLabels
        && typeof requestedPickerLabels === "object"
        && !Array.isArray(requestedPickerLabels)
        && Object.values(requestedPickerLabels).every((label) => typeof label === "string")
      );
    if (!isNonEmptyString(baseUrl)
      || !isOptionalString(apiKey)
      || models.length === 0
      || !pickerLabelsValid) {
      return NextResponse.json({
        error: "baseUrl, models, API key, or picker labels are invalid",
      }, { status: 400 });
    }

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";
    const activeModel = resolveDefaultModel(defaultModel || model, models);
    const pickerLabels = normalizeClaudeCatalogPickerLabels(requestedPickerLabels, models);
    const ensureProviders = (fileData) => {
      if (!fileData.providers || typeof fileData.providers !== "object" || Array.isArray(fileData.providers)) {
        fileData.providers = {};
      }
    };
    ensureProviders(ymlData);
    ensureProviders(data);

    const managedProvider = {
      baseUrl: normalized,
      api: "openai-completions",
      apiKey: key,
      authHeader: true,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
      },
      models: buildPiModelEntries(models, previousModels, pickerLabels),
    };
    // omp: curated entries stay pinned (labels/context), discovery exposes
    // every other live Switchboard model without a dashboard round-trip.
    const managedYmlProvider = {
      ...managedProvider,
      discovery: { type: "openai-models-list" },
    };
    const backup = storedBackup?.version === BACKUP_VERSION
      ? storedBackup
      : {
          version: BACKUP_VERSION,
          state: "active",
          provider: snapshotObjectKeys(ymlData.providers, [PROVIDER_ID])[PROVIDER_ID],
          legacyProvider: snapshotObjectKeys(data.providers, [PROVIDER_ID])[PROVIDER_ID],
          settings: snapshotObjectKeys(piSettings, ["defaultProvider", "defaultModel", "enabledModels"]),
        };

    ymlData.providers[PROVIDER_ID] = managedYmlProvider;
    data.providers[PROVIDER_ID] = managedProvider;
    piSettings.defaultProvider = PROVIDER_ID;
    piSettings.defaultModel = activeModel;
    const mergedEnabled = mergeEnabledModels(piSettings.enabledModels, canonicalModelIds(models));
    if (mergedEnabled) piSettings.enabledModels = mergedEnabled;
    else delete piSettings.enabledModels;
    backup.managedProvider = managedYmlProvider;
    backup.managedLegacyProvider = managedProvider;
    backup.managedSettings = {
      defaultProvider: PROVIDER_ID,
      defaultModel: activeModel,
      enabledModels: piSettings.enabledModels,
    };

    await writePiState(ymlData, data, piSettings, backup);

    return NextResponse.json({
      success: true,
      message: `Pi configured with ${models.length} model${models.length === 1 ? "" : "s"}. ${activeModel} is the default; use /model to switch.`,
      pickerLabels: Object.fromEntries(
        managedProvider.models.map((entry) => [entry.id, entry.name]),
      ),
      configPath: getModelsYmlPath(),
      settingsPath: getSettingsPath(),
    });
  } catch (error) {
    console.log("Error updating pi settings:", error);
    return NextResponse.json({ error: "Failed to update pi settings" }, { status: 500 });
  }
}

export async function POST(request) {
  return withMutationLock(() => postPiSettings(request));
}

async function deletePiSettings() {
  try {
    const [ymlData, data, piSettings, rawBackup] = await Promise.all([
      readModelsYml(),
      readModels(),
      readSettings(),
      readBackup(),
    ]);
    const backup = validateBackup(rawBackup);
    if (backup?.state === "restored") {
      return NextResponse.json({
        success: true,
        message: "No Switchboard Pi settings to reset",
      });
    }
    const ymlProvider = ymlData?.providers?.[PROVIDER_ID];
    const jsonProvider = data?.providers?.[PROVIDER_ID];
    const hasManagedProvider = !!(ymlProvider || jsonProvider);
    const hasManagedSettings = piSettings.defaultProvider === PROVIDER_ID
      || (Array.isArray(piSettings.enabledModels)
        && piSettings.enabledModels.some((entry) => typeof entry === "string" && entry.startsWith(`${PROVIDER_ID}/`)));
    if (!backup && !hasManagedProvider && !hasManagedSettings) {
      return NextResponse.json({
        success: true,
        message: "No Switchboard Pi settings to reset",
      });
    }
    if (ymlProvider
      && (!backup?.managedProvider || sameJson(ymlProvider, backup.managedProvider))) {
      if (backup?.version === BACKUP_VERSION) {
        restoreObjectKeys(ymlData.providers, { [PROVIDER_ID]: backup.provider });
      } else {
        delete ymlData.providers[PROVIDER_ID];
      }
    }
    if (jsonProvider
      && (!backup?.managedLegacyProvider || sameJson(jsonProvider, backup.managedLegacyProvider))) {
      if (backup?.version === BACKUP_VERSION) {
        // Backups written before models.yml was managed only snapshot the
        // models.json provider; reuse it for both files.
        restoreObjectKeys(data.providers, { [PROVIDER_ID]: backup.legacyProvider ?? backup.provider });
      } else {
        delete data.providers[PROVIDER_ID];
      }
    }
    if (backup?.version === BACKUP_VERSION) {
      // Restore the model before the provider: the ownership guard needs to
      // observe the Switchboard provider that was active at delete time.
      restoreManagedSetting(piSettings, backup, "defaultModel");
      restoreManagedSetting(piSettings, backup, "defaultProvider");
      restoreManagedSetting(piSettings, backup, "enabledModels");
    } else if (piSettings.defaultProvider === PROVIDER_ID) {
      delete piSettings.defaultProvider;
      delete piSettings.defaultModel;
    }
    if (!backup && Array.isArray(piSettings.enabledModels)) {
      piSettings.enabledModels = piSettings.enabledModels.filter(
        (entry) => typeof entry !== "string" || !entry.startsWith(`${PROVIDER_ID}/`),
      );
      if (piSettings.enabledModels.length === 0) delete piSettings.enabledModels;
    }
    await writePiState(ymlData, data, piSettings, {
      version: BACKUP_VERSION,
      state: "restored",
    });
    return NextResponse.json({
      success: true,
      message: "Switchboard provider removed and previous Pi model settings restored",
    });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json({ error: "Failed to reset pi settings" }, { status: 500 });
  }
}

export async function DELETE() {
  return withMutationLock(deletePiSettings);
}
