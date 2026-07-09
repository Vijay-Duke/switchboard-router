// @ts-check
"use server";

/**
 * Aider (https://aider.chat) — OpenAI-compatible via ~/.aider.conf.yml
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const getConfigPath = () => path.join(os.homedir(), ".aider.conf.yml");

const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

const isLocalBase = (url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    await execAsync(isWindows ? "where aider" : "which aider", { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

/** Best-effort YAML key: value reader (flat keys only). */
const parseFlatYaml = (text) => {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
};

const SWITCHBOARD_MARKER = "# switchboard-managed";

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Aider is not installed",
      });
    }

    let raw = "";
    try {
      raw = await fs.readFile(getConfigPath(), "utf-8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const flat = parseFlatYaml(raw);
    const baseUrl = flat["openai-api-base"] || flat["openai_api_base"] || null;
    const model = flat.model || null;
    const managed = raw.includes(SWITCHBOARD_MARKER);
    const hasSwitchboard = !!(managed && baseUrl && isLocalBase(baseUrl));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        apiKeySet: !!(flat["openai-api-key"] || flat["openai_api_key"]),
      },
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.log("Error checking aider settings:", error);
    return NextResponse.json({ error: "Failed to check aider settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";
    // Aider expects openai/<name> for OpenAI-compatible providers
    const aiderModel = model.startsWith("openai/") ? model : `openai/${model}`;

    // Preserve non-managed keys from existing file when possible
    let existing = {};
    try {
      const raw = await fs.readFile(getConfigPath(), "utf-8");
      existing = parseFlatYaml(raw);
    } catch {
      /* new file */
    }

    const body = `${SWITCHBOARD_MARKER}
# Point Aider at Switchboard (OpenAI-compatible)
openai-api-base: ${normalized}
openai-api-key: ${key}
model: ${aiderModel}
`;

    // Keep a few safe unrelated settings if present
    const keepKeys = ["dark-mode", "auto-commits", "git", "map-tokens", "user-prompts"];
    let extras = "";
    for (const k of keepKeys) {
      if (existing[k] != null && existing[k] !== "") {
        extras += `${k}: ${existing[k]}\n`;
      }
    }

    await fs.writeFile(getConfigPath(), body + (extras ? `\n# preserved\n${extras}` : ""));

    return NextResponse.json({
      success: true,
      message: "Aider configured (~/.aider.conf.yml)",
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.log("Error updating aider settings:", error);
    return NextResponse.json({ error: "Failed to update aider settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getConfigPath();
    let raw = "";
    try {
      raw = await fs.readFile(configPath, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw e;
    }

    if (!raw.includes(SWITCHBOARD_MARKER)) {
      return NextResponse.json({
        success: true,
        message: "Config was not switchboard-managed; left unchanged",
      });
    }

    // Remove managed file content — leave empty stub
    await fs.writeFile(configPath, `# aider config (switchboard settings removed)\n`);
    return NextResponse.json({ success: true, message: "Switchboard Aider settings removed" });
  } catch (error) {
    console.log("Error resetting aider settings:", error);
    return NextResponse.json({ error: "Failed to reset aider settings" }, { status: 500 });
  }
}
