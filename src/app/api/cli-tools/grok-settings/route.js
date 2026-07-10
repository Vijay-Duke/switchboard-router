// @ts-check
"use server";

/**
 * Grok CLI (superagent-ai/grok-cli / npm: grok-dev)
 * - apiKey + defaultModel → ~/.grok/user-settings.json
 * - GROK_BASE_URL only via env → ~/.grok/switchboard.env (source before `grok`)
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { isSingleLineString, parseQuotedShellValue, quoteShellValue } from "@/lib/cli/shellEnv.js";
import { isOptionalString } from "@/lib/cli/modelCatalog.js";
import {
  replaceCliFiles,
  restoreObjectKeys,
  snapshotObjectKeys,
} from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);
const BACKUP_VERSION = 1;

const getGrokDir = () => path.join(os.homedir(), ".grok");
const getUserSettingsPath = () => path.join(getGrokDir(), "user-settings.json");
const getEnvPath = () => path.join(getGrokDir(), "switchboard.env");
const getBackupPath = () => path.join(getGrokDir(), "switchboard-backup.json");

const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

const isLocalBase = (url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));

/**
 * True only when the CLI binary is on PATH.
 * Do not treat ~/.grok alone as installed — Apply creates that dir for config.
 */
const checkInstalled = async () => {
  const isWindows = os.platform() === "win32";
  const cmds = isWindows
    ? ["where grok", "where grok-dev"]
    : ["which grok", "which grok-dev"];
  for (const cmd of cmds) {
    try {
      await execAsync(cmd, { windowsHide: true });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
};

const readJson = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

const readTextSnapshot = async (filePath) => {
  try {
    return { exists: true, value: await fs.readFile(filePath, "utf-8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: null };
    throw error;
  }
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const validateBackup = (backup) => {
  if (backup == null) return null;
  if (backup.version === BACKUP_VERSION && backup.state === "restored") return backup;
  if (backup.version !== BACKUP_VERSION
    || !backup.settings
    || !backup.env
    || !backup.managedSettings
    || typeof backup.managedEnv !== "string") {
    throw new Error("Unsupported or invalid Grok Switchboard backup file");
  }
  return backup;
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
      const v = parseQuotedShellValue(body.slice(eq + 1));
      out[body.slice(0, eq).trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Grok CLI is not installed",
      });
    }

    const user = (await readJson(getUserSettingsPath())) || {};
    const env = await parseEnvFile();
    const baseUrl = env.GROK_BASE_URL || null;
    const model = env.GROK_MODEL || user.defaultModel || null;
    const hasSwitchboard = !!(baseUrl && isLocalBase(baseUrl) && (user.apiKey || env.GROK_API_KEY));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        apiKeySet: !!(user.apiKey || env.GROK_API_KEY),
      },
      configPath: getUserSettingsPath(),
      envPath: getEnvPath(),
    });
  } catch (error) {
    console.log("Error checking grok settings:", error);
    return NextResponse.json({ error: "Failed to check grok settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!isSingleLineString(baseUrl)
      || !isOptionalString(apiKey)
      || (typeof apiKey === "string" && !isSingleLineString(apiKey, { allowEmpty: true }))
      || !isSingleLineString(model)) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }
    try {
      const parsedBaseUrl = new URL(baseUrl);
      if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) throw new Error("unsupported protocol");
    } catch {
      return NextResponse.json({ error: "baseUrl must be a valid HTTP(S) URL" }, { status: 400 });
    }

    const dir = getGrokDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";

    // Merge user-settings (preserve telegram, hooks, etc.)
    const existingFile = await readJson(getUserSettingsPath());
    const existing = existingFile || {};
    const next = {
      ...existing,
      apiKey: key,
      defaultModel: model,
    };
    // Env file — GROK_BASE_URL is only read from process env by the CLI
    const envBody = `# Switchboard → Grok CLI
# source ~/.grok/switchboard.env   then run: grok
export GROK_API_KEY=${quoteShellValue(key)}
export GROK_BASE_URL=${quoteShellValue(normalized)}
export GROK_MODEL=${quoteShellValue(model)}
`;
    const existingEnv = await readTextSnapshot(getEnvPath());
    const validatedBackup = validateBackup(await readJson(getBackupPath()));
    const storedBackup = validatedBackup?.state === "restored" ? null : validatedBackup;
    const backup = storedBackup || {
      version: BACKUP_VERSION,
      state: "active",
      settingsFileExisted: existingFile !== null,
      settings: snapshotObjectKeys(existing, ["apiKey", "defaultModel"]),
      env: existingEnv,
    };
    backup.managedSettings = { apiKey: key, defaultModel: model };
    backup.managedEnv = envBody;
    await replaceCliFiles([
      {
        filePath: getBackupPath(),
        content: JSON.stringify(backup, null, 2),
        secret: true,
      },
      {
        filePath: getUserSettingsPath(),
        content: JSON.stringify(next, null, 2),
        secret: true,
      },
      { filePath: getEnvPath(), content: envBody, secret: true },
    ]);

    return NextResponse.json({
      success: true,
      message: "Grok settings applied. Source ~/.grok/switchboard.env before running grok.",
      configPath: getUserSettingsPath(),
      envPath: getEnvPath(),
    });
  } catch (error) {
    console.log("Error updating grok settings:", error);
    return NextResponse.json({ error: "Failed to update grok settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const backup = validateBackup(await readJson(getBackupPath()));
    if (backup?.state === "restored") {
      return NextResponse.json({ success: true, message: "No Switchboard Grok settings to reset" });
    }
    const existingFile = await readJson(getUserSettingsPath());
    const existing = existingFile || {};
    const currentEnv = await readTextSnapshot(getEnvPath());
    if (!backup && existingFile === null && !currentEnv.exists) {
      return NextResponse.json({ success: true, message: "No Switchboard Grok settings to reset" });
    }

    if (backup) {
      for (const key of ["apiKey", "defaultModel"]) {
        if (sameJson(existing[key], backup.managedSettings[key])) {
          restoreObjectKeys(existing, { [key]: backup.settings[key] });
        }
      }
    } else if (currentEnv.exists) {
      // Legacy Switchboard versions had no backup but always wrote this
      // dedicated env file alongside the two user-settings keys.
      delete existing.apiKey;
      delete existing.defaultModel;
    }

    const settingsContent = backup && !backup.settingsFileExisted && Object.keys(existing).length === 0
      ? null
      : JSON.stringify(existing, null, 2);
    const envContent = backup
      ? (currentEnv.value === backup.managedEnv
          ? (backup.env.exists ? backup.env.value : null)
          : currentEnv.value)
      : null;
    await replaceCliFiles([
      {
        filePath: getBackupPath(),
        content: JSON.stringify({ version: BACKUP_VERSION, state: "restored" }, null, 2),
        secret: true,
      },
      { filePath: getUserSettingsPath(), content: settingsContent, secret: true },
      { filePath: getEnvPath(), content: envContent, secret: true },
    ]);

    return NextResponse.json({
      success: true,
      message: "Switchboard Grok env reset and previous settings restored",
    });
  } catch (error) {
    console.log("Error resetting grok settings:", error);
    return NextResponse.json({ error: "Failed to reset grok settings" }, { status: 500 });
  }
}
