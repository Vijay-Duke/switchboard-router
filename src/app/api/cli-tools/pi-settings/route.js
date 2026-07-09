// @ts-check
"use server";

/**
 * Pi coding agent (@earendil-works/pi-coding-agent)
 * Custom OpenAI-compatible provider via ~/.pi/agent/models.json
 * docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
 */
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const PROVIDER_ID = "switchboard";

const getAgentDir = () => path.join(os.homedir(), ".pi", "agent");
const getModelsPath = () => path.join(getAgentDir(), "models.json");

const normalizeBaseUrl = (baseUrl) => {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
};

const isLocalBase = (url) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ""));

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

const readModels = async () => {
  try {
    const raw = await fs.readFile(getModelsPath(), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return { providers: {} };
    throw e;
  }
};

const writeModels = async (data) => {
  await fs.mkdir(getAgentDir(), { recursive: true });
  await fs.writeFile(getModelsPath(), JSON.stringify(data, null, 2));
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Pi is not installed",
      });
    }

    const data = await readModels();
    const provider = data?.providers?.[PROVIDER_ID] || null;
    const model = provider?.models?.[0]?.id || null;
    const baseUrl = provider?.baseUrl || null;
    const hasSwitchboard = !!(provider && isLocalBase(baseUrl));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        apiKeySet: !!provider?.apiKey,
        provider: PROVIDER_ID,
      },
      configPath: getModelsPath(),
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json({ error: "Failed to check pi settings" }, { status: 500 });
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
    const data = await readModels();
    if (!data.providers || typeof data.providers !== "object") data.providers = {};

    // Keep other custom providers; replace switchboard entry
    const prevModels = data.providers[PROVIDER_ID]?.models || [];
    const modelEntry = {
      id: model,
      name: model.includes("/") ? model.split("/").slice(1).join("/") || model : model,
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 16384,
    };
    // Upsert selected model first; keep previous switchboard models (by id) as extras
    const extras = prevModels.filter((m) => m?.id && m.id !== model).slice(0, 12);

    data.providers[PROVIDER_ID] = {
      baseUrl: normalized,
      api: "openai-completions",
      apiKey: key,
      authHeader: true,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
      },
      models: [modelEntry, ...extras],
    };

    await writeModels(data);

    return NextResponse.json({
      success: true,
      message: `Pi configured. In pi use /model → ${PROVIDER_ID}/${model}`,
      configPath: getModelsPath(),
    });
  } catch (error) {
    console.log("Error updating pi settings:", error);
    return NextResponse.json({ error: "Failed to update pi settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const data = await readModels();
    if (data?.providers?.[PROVIDER_ID]) {
      delete data.providers[PROVIDER_ID];
      await writeModels(data);
    }
    return NextResponse.json({
      success: true,
      message: "Switchboard provider removed from Pi models.json",
    });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json({ error: "Failed to reset pi settings" }, { status: 500 });
  }
}
