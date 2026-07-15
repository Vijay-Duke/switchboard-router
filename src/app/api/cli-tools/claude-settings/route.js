// @ts-check
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  replaceCliFiles,
  restoreObjectKeys,
  snapshotObjectKeys,
} from "@/lib/cli/fileIo.js";
import { hasClaudePassThroughHeader } from "@/shared/claudeGateway.js";

const execAsync = promisify(exec);
const BACKUP_VERSION = 1;

const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "API_TIMEOUT_MS",
];
const LEGACY_MANAGED_ENV_KEYS = MANAGED_ENV_KEYS.filter((key) => key !== "ANTHROPIC_API_KEY");

// The settings file and backup must move through Apply/Disconnect as one
// generation. Serialize mutations so concurrent clicks cannot overwrite the
// original snapshot or restore a partially applied configuration.
let mutationTail = Promise.resolve();

const withMutationLock = (operation) => {
  const next = mutationTail.then(operation, operation);
  mutationTail = next.catch(() => {});
  return next;
};

const getClaudeDir = () => path.join(os.homedir(), ".claude");
const getClaudeSettingsPath = () => path.join(getClaudeDir(), "settings.json");
const getBackupPath = () => path.join(getClaudeDir(), "switchboard-backup.json");

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const isSnapshot = (value) => isObject(value) && typeof value.exists === "boolean";

const parseSettings = (content) => {
  // Claude settings are commonly edited as JSON with trailing commas.
  const parsed = JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
  if (!isObject(parsed)) throw new TypeError("Claude settings must contain a JSON object");
  return parsed;
};

const readSettingsFile = async () => {
  try {
    const raw = await fs.readFile(getClaudeSettingsPath(), "utf-8");
    return { exists: true, raw, settings: parseSettings(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, raw: null, settings: {} };
    throw error;
  }
};

const readBackup = async () => {
  try {
    const raw = await fs.readFile(getBackupPath(), "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const validateBackup = (backup) => {
  if (backup == null) return null;
  if (backup.version === BACKUP_VERSION && backup.state === "restored") return backup;
  if (backup.version !== BACKUP_VERSION
    || backup.state !== "active"
    || typeof backup.settingsFileExisted !== "boolean"
    || typeof backup.canRestoreExact !== "boolean"
    || (backup.originalContent !== null && typeof backup.originalContent !== "string")
    || !isSnapshot(backup.hasCompletedOnboarding)
    || !isObject(backup.env)
    || !Array.isArray(backup.managedEnvKeys)
    || !backup.managedEnvKeys.every((key) => typeof key === "string" && isSnapshot(backup.env[key]))
    || !isObject(backup.managedSettings)) {
    throw new Error("Unsupported or invalid Claude Code Switchboard backup file");
  }
  return backup;
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const snapshotMatches = (object, key, snapshot) => (
  Object.hasOwn(object, key) === snapshot.exists
  && (!snapshot.exists || sameJson(object[key], snapshot.value))
);

const restoreIfStillManaged = (object, key, managedSnapshot, originalSnapshot) => {
  if (snapshotMatches(object, key, managedSnapshot)) {
    restoreObjectKeys(object, { [key]: originalSnapshot });
  }
};

const isLocalBaseUrl = (value) => {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "0.0.0.0"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
};

const looksLikeLegacySwitchboard = (settings) => {
  const env = isObject(settings?.env) ? settings.env : {};
  return env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
    || env.ANTHROPIC_AUTH_TOKEN === "sk_switchboard"
    || detectRoutingMode(settings) === "pass-through"
    || isLocalBaseUrl(env.ANTHROPIC_BASE_URL);
};

/**
 * Infer which Switchboard gateway mode is represented by Claude's settings.
 * @param {Record<string, any> | null | undefined} settings
 * @returns {"pass-through" | "proxy" | null}
 */
const detectRoutingMode = (settings) => {
  const env = isObject(settings?.env) ? settings.env : {};
  if (hasClaudePassThroughHeader(env.ANTHROPIC_CUSTOM_HEADERS)) {
    return "pass-through";
  }
  return env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_BASE_URL ? "proxy" : null;
};

const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

async function getClaudeSettings() {
  try {
    const isInstalled = await checkClaudeInstalled();
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const [{ settings }, rawBackup] = await Promise.all([readSettingsFile(), readBackup()]);
    const backup = validateBackup(rawBackup);
    const hasBackup = backup?.state === "active";
    const hasSwitchboard = hasBackup || looksLikeLegacySwitchboard(settings);

    return NextResponse.json({
      installed: true,
      settings,
      hasSwitchboard,
      hasBackup,
      routingMode: detectRoutingMode(settings),
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json({ error: "Failed to check claude settings" }, { status: 500 });
  }
}

export async function GET() {
  return withMutationLock(getClaudeSettings);
}

async function postClaudeSettings(request) {
  try {
    const body = await request.json();
    const requestedEnv = body?.env;
    if (!isObject(requestedEnv)) {
      return NextResponse.json({ error: "Invalid env object" }, { status: 400 });
    }
    const removeEnvKeys = body?.removeEnvKeys ?? [];
    if (!Array.isArray(removeEnvKeys)
      || !removeEnvKeys.every((key) => typeof key === "string" && MANAGED_ENV_KEYS.includes(key))) {
      return NextResponse.json({ error: "Invalid removeEnvKeys" }, { status: 400 });
    }
    const [{ exists, raw, settings: currentSettings }, rawBackup] = await Promise.all([
      readSettingsFile(),
      readBackup(),
    ]);
    const validatedBackup = validateBackup(rawBackup);
    const storedBackup = validatedBackup?.state === "active" ? validatedBackup : null;
    const env = { ...requestedEnv };
    if (env.ANTHROPIC_BASE_URL) {
      const baseUrl = String(env.ANTHROPIC_BASE_URL).replace(/\/+$/, "");
      env.ANTHROPIC_BASE_URL = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    }

    const nextEnv = {
      ...(isObject(currentSettings.env) ? currentSettings.env : {}),
      ...env,
    };
    for (const key of removeEnvKeys) delete nextEnv[key];
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      ...(Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    };
    if (Object.keys(nextEnv).length === 0) delete newSettings.env;
    const currentEnv = isObject(currentSettings.env) ? currentSettings.env : {};
    const requestedKeys = Array.from(new Set([...Object.keys(env), ...removeEnvKeys]));
    const backup = storedBackup || {
      version: BACKUP_VERSION,
      state: "active",
      settingsFileExisted: exists,
      canRestoreExact: true,
      originalContent: raw,
      hasCompletedOnboarding: snapshotObjectKeys(currentSettings, ["hasCompletedOnboarding"]).hasCompletedOnboarding,
      managedEnvKeys: requestedKeys,
      env: snapshotObjectKeys(currentEnv, requestedKeys),
    };
    if (storedBackup) {
      backup.canRestoreExact = backup.canRestoreExact
        && sameJson(currentSettings, backup.managedSettings);
      const managedKeySet = new Set(backup.managedEnvKeys);
      const newManagedKeys = requestedKeys.filter((key) => !managedKeySet.has(key));
      Object.assign(backup.env, snapshotObjectKeys(currentEnv, newManagedKeys));
      backup.managedEnvKeys.push(...newManagedKeys);
    }
    backup.managedSettings = newSettings;

    await fs.mkdir(getClaudeDir(), { recursive: true });
    await replaceCliFiles([
      {
        filePath: getBackupPath(),
        content: JSON.stringify(backup, null, 2),
        secret: true,
      },
      {
        filePath: getClaudeSettingsPath(),
        content: JSON.stringify(newSettings, null, 2),
        secret: true,
      },
    ]);

    return NextResponse.json({
      success: true,
      hasBackup: true,
      message: "Claude Code connected to Switchboard",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json({ error: "Failed to update Claude Code settings." }, { status: 500 });
  }
}

export async function POST(request) {
  return withMutationLock(() => postClaudeSettings(request));
}

async function deleteClaudeSettings() {
  try {
    const [settingsFile, rawBackup] = await Promise.all([readSettingsFile(), readBackup()]);
    const validatedBackup = validateBackup(rawBackup);
    const hasLegacySettings = looksLikeLegacySwitchboard(settingsFile.settings);
    const backup = validatedBackup?.state === "active" ? validatedBackup : null;
    if (validatedBackup?.state === "restored" && !hasLegacySettings) {
      return NextResponse.json({
        success: true,
        restored: true,
        message: "Claude Code is already disconnected",
      });
    }
    if (!settingsFile.exists && !backup) {
      return NextResponse.json({
        success: true,
        restored: false,
        message: "No Claude Code settings to disconnect",
      });
    }
    if (!backup && !hasLegacySettings) {
      return NextResponse.json({
        success: true,
        restored: false,
        message: "Claude Code is not connected to Switchboard",
      });
    }

    let settingsContent;
    let restored = false;
    let legacyCleanup = false;
    if (backup?.state === "active") {
      restored = true;
      if (backup.canRestoreExact
        && (!settingsFile.exists || sameJson(settingsFile.settings, backup.managedSettings))) {
        // The file was untouched after Apply, so restore its exact original
        // bytes (including formatting and trailing commas).
        settingsContent = backup.settingsFileExisted ? backup.originalContent : null;
      } else {
        // Preserve edits made while connected and restore only fields that
        // still equal the values last written by Switchboard.
        const current = settingsFile.settings;
        const currentEnv = isObject(current.env) ? current.env : {};
        const managedEnv = isObject(backup.managedSettings.env) ? backup.managedSettings.env : {};
        for (const key of backup.managedEnvKeys) {
          restoreIfStillManaged(
            currentEnv,
            key,
            snapshotObjectKeys(managedEnv, [key])[key],
            backup.env[key],
          );
        }
        if (Object.keys(currentEnv).length > 0) current.env = currentEnv;
        else delete current.env;
        restoreIfStillManaged(
          current,
          "hasCompletedOnboarding",
          snapshotObjectKeys(backup.managedSettings, ["hasCompletedOnboarding"]).hasCompletedOnboarding,
          backup.hasCompletedOnboarding,
        );
        settingsContent = !backup.settingsFileExisted && Object.keys(current).length === 0
          ? null
          : JSON.stringify(current, null, 2);
      }
    } else {
      // Versions through v0.6.16 did not create the backup promised by the
      // UI. We cannot recover overwritten values, but we can remove only the
      // known Switchboard fields and preserve every unrelated setting.
      legacyCleanup = true;
      const current = settingsFile.settings;
      if (isObject(current.env)) {
        for (const key of LEGACY_MANAGED_ENV_KEYS) delete current.env[key];
        if (Object.keys(current.env).length === 0) delete current.env;
      }
      settingsContent = JSON.stringify(current, null, 2);
    }

    await fs.mkdir(getClaudeDir(), { recursive: true });
    await replaceCliFiles([
      {
        filePath: getBackupPath(),
        content: JSON.stringify({ version: BACKUP_VERSION, state: "restored" }, null, 2),
        secret: true,
      },
      {
        filePath: getClaudeSettingsPath(),
        content: settingsContent,
        secret: true,
      },
    ]);

    return NextResponse.json({
      success: true,
      restored,
      legacyCleanup,
      message: restored
        ? "Switchboard disconnected and previous Claude Code settings restored"
        : "Switchboard disconnected; no Switchboard backup was available for overwritten values",
    });
  } catch (error) {
    console.log("Error disconnecting claude settings:", error);
    return NextResponse.json({ error: "Failed to disconnect Claude Code" }, { status: 500 });
  }
}

export async function DELETE() {
  return withMutationLock(deleteClaudeSettings);
}
