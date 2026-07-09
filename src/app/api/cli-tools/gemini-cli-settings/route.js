// @ts-check
"use server";

/**
 * Google Gemini CLI — OpenAI-compatible mode via env + ~/.gemini/switchboard.env
 * Official CLI often uses GEMINI_API_KEY; many builds also honor OPENAI_* when
 * pointed at an OpenAI-compatible gateway. We write both styles for reliability.
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const getGeminiDir = () => path.join(os.homedir(), ".gemini");
const getEnvPath = () => path.join(getGeminiDir(), "switchboard.env");
const getSettingsPath = () => path.join(getGeminiDir(), "settings.json");

const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

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
    const baseUrl = env.OPENAI_BASE_URL || env.GEMINI_API_BASE_URL || null;
    const model = env.OPENAI_MODEL || env.GEMINI_MODEL || null;
    const hasSwitchboard = !!(baseUrl && isLocalBase(baseUrl));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        apiKeySet: !!(env.OPENAI_API_KEY || env.GEMINI_API_KEY),
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
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    await fs.mkdir(getGeminiDir(), { recursive: true });
    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";

    const envBody = `# Switchboard → Gemini CLI
# source ~/.gemini/switchboard.env   then run: gemini
export OPENAI_API_KEY="${key}"
export OPENAI_BASE_URL="${normalized}"
export OPENAI_MODEL="${model}"
export GEMINI_API_KEY="${key}"
export GEMINI_API_BASE_URL="${normalized}"
export GEMINI_MODEL="${model}"
`;
    await fs.writeFile(getEnvPath(), envBody, { mode: 0o600 });

    // Best-effort merge into settings.json if present (non-destructive)
    try {
      let settings = {};
      try {
        settings = JSON.parse(await fs.readFile(getSettingsPath(), "utf-8"));
      } catch {
        settings = {};
      }
      if (!settings.env || typeof settings.env !== "object") settings.env = {};
      settings.env.OPENAI_API_KEY = key;
      settings.env.OPENAI_BASE_URL = normalized;
      settings.env.OPENAI_MODEL = model;
      if (!settings.model || typeof settings.model !== "object") settings.model = {};
      if (!settings.model.name) settings.model.name = model;
      await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) {
      console.warn("gemini settings.json merge skipped:", e?.message || e);
    }

    return NextResponse.json({
      success: true,
      message: "Gemini CLI env written. Source ~/.gemini/switchboard.env before running gemini.",
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
      await fs.unlink(getEnvPath());
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return NextResponse.json({ success: true, message: "Switchboard Gemini env removed" });
  } catch (error) {
    console.log("Error resetting gemini-cli settings:", error);
    return NextResponse.json({ error: "Failed to reset gemini-cli settings" }, { status: 500 });
  }
}
