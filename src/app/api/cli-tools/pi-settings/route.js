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
import { buildPiModelEntries, isNonEmptyString, isOptionalString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { writeCliFile } from "@/lib/cli/fileIo.js";

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
  await writeCliFile(getModelsPath(), JSON.stringify(data, null, 2), { secret: true });
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
    const models = Array.isArray(provider?.models)
      ? provider.models.map((entry) => entry?.id).filter(Boolean)
      : [];
    const model = models[0] || null;
    const baseUrl = provider?.baseUrl || null;
    const hasSwitchboard = !!(provider && isLocalBase(baseUrl));

    return NextResponse.json({
      installed: true,
      hasSwitchboard,
      settings: {
        baseUrl,
        model,
        models,
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
    const { baseUrl, apiKey, model, models: requestedModels } = await request.json();
    const data = await readModels();
    const previousModels = data?.providers?.[PROVIDER_ID]?.models || [];
    const legacyModels = requestedModels === undefined
      ? [model, ...previousModels.map((entry) => entry?.id)]
      : requestedModels;
    const models = normalizeModelIds(legacyModels);
    if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const normalized = normalizeBaseUrl(baseUrl);
    const key = apiKey || "sk_switchboard";
    if (!data.providers || typeof data.providers !== "object") data.providers = {};

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
      models: buildPiModelEntries(models, previousModels),
    };

    await writeModels(data);

    return NextResponse.json({
      success: true,
      message: `Pi configured with ${models.length} model${models.length === 1 ? "" : "s"}. Use /model to switch.`,
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
