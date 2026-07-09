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

const execAsync = promisify(exec);

const getGrokDir = () => path.join(os.homedir(), ".grok");
const getUserSettingsPath = () => path.join(getGrokDir(), "user-settings.json");
const getEnvPath = () => path.join(getGrokDir(), "switchboard.env");

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
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const dir = getGrokDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";

    // Merge user-settings (preserve telegram, hooks, etc.)
    const existing = (await readJson(getUserSettingsPath())) || {};
    const next = {
      ...existing,
      apiKey: key,
      defaultModel: model,
    };
    await fs.writeFile(getUserSettingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });

    // Env file — GROK_BASE_URL is only read from process env by the CLI
    const envBody = `# Switchboard → Grok CLI
# source ~/.grok/switchboard.env   then run: grok
export GROK_API_KEY="${key}"
export GROK_BASE_URL="${normalized}"
export GROK_MODEL="${model}"
`;
    await fs.writeFile(getEnvPath(), envBody, { mode: 0o600 });

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
    // Remove switchboard.env; strip switchboard keys from user-settings if present
    try {
      await fs.unlink(getEnvPath());
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    const existing = (await readJson(getUserSettingsPath())) || {};
    if (existing.apiKey || existing.defaultModel) {
      const { apiKey, defaultModel, ...rest } = existing;
      // Only clear if it looks like our local key pattern or keep structure clean
      await fs.writeFile(getUserSettingsPath(), JSON.stringify(rest, null, 2), { mode: 0o600 });
    }

    return NextResponse.json({
      success: true,
      message: "Switchboard Grok env reset (user-settings apiKey/defaultModel cleared)",
    });
  } catch (error) {
    console.log("Error resetting grok settings:", error);
    return NextResponse.json({ error: "Failed to reset grok settings" }, { status: 500 });
  }
}
