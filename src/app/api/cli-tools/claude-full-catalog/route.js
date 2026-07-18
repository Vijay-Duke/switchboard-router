// @ts-check
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir.js";
import { replaceCliFiles } from "@/lib/cli/fileIo.js";
import { getCombos, getProviderConnections } from "@/lib/db/index.js";
import {
  AI_PROVIDERS,
  FREE_PROVIDERS,
  getProviderAlias,
} from "@/shared/constants/providers.js";
import {
  buildClaudeFullCatalogProfile,
  fingerprintClaudeGatewayKey,
  hasClaudeFullCatalogHeader,
  normalizeClaudeCatalogPickerLabels,
  readClaudeCatalogSelectionFromCustomHeaders,
} from "@/shared/claudeGateway.js";

export const getClaudeFullCatalogProfilePath = () => path.join(
  getDataDir(),
  "claude-code",
  "full-catalog-settings.json",
);

const readProfile = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(getClaudeFullCatalogProfilePath(), "utf8"));
    const env = parsed?.env && typeof parsed.env === "object" ? parsed.env : {};
    const models = readClaudeCatalogSelectionFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS);
    return {
      configured: Boolean(
        env.ANTHROPIC_BASE_URL
        && env.ANTHROPIC_AUTH_TOKEN
        && env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
        && hasClaudeFullCatalogHeader(env.ANTHROPIC_CUSTOM_HEADERS),
      ),
      baseUrl: typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null,
      gatewayKeyFingerprint: fingerprintClaudeGatewayKey(env.ANTHROPIC_AUTH_TOKEN),
      models,
      pickerLabels: normalizeClaudeCatalogPickerLabels(parsed?.pickerLabels, models),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        configured: false,
        baseUrl: null,
        gatewayKeyFingerprint: "",
        models: [],
        pickerLabels: {},
      };
    }
    throw error;
  }
};

const responseBody = (status) => ({
  ...status,
  launcher: "claude-switchboard",
  settingsPath: getClaudeFullCatalogProfilePath(),
});

/**
 * Validate saved selections against local Switchboard state only. Provider
 * catalogs are intentionally not fetched here or during Claude discovery.
 *
 * @param {string[]} models
 * @param {Array<Record<string, any>>} connections
 * @param {Array<Record<string, any>>} combos
 */
export function findUnavailableClaudeCatalogModels(models, connections, combos) {
  const activePrefixes = new Set(
    connections
      .filter((connection) => connection?.isActive !== false)
      .map((connection) => (
        connection?.providerSpecificData?.prefix
        || getProviderAlias(connection?.provider)
      ))
      .filter(Boolean),
  );
  for (const providerId of Object.keys(FREE_PROVIDERS)) {
    const provider = AI_PROVIDERS[providerId];
    const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
      ? provider.serviceKinds
      : ["llm"];
    if (provider?.noAuth && kinds.includes("llm")) {
      activePrefixes.add(getProviderAlias(providerId));
    }
  }
  const comboNames = new Set(
    combos
      .filter((combo) => !combo?.kind || combo.kind === "llm")
      .map((combo) => combo?.name)
      .filter(Boolean),
  );

  return models.filter((modelId) => {
    const separator = modelId.indexOf("/");
    if (separator < 0) return !comboNames.has(modelId);
    return !activePrefixes.has(modelId.slice(0, separator));
  });
}

export async function GET() {
  try {
    return NextResponse.json(responseBody(await readProfile()));
  } catch (error) {
    console.log("Error reading Claude full-catalog profile:", error);
    return NextResponse.json({ error: "Failed to read Claude full-catalog profile" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (typeof body?.baseUrl !== "string" || typeof body?.gatewayKey !== "string") {
      return NextResponse.json({ error: "Invalid full-catalog profile" }, { status: 400 });
    }
    let profile;
    try {
      const url = new URL(body.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("Unsupported endpoint protocol");
      }
      const models = Array.isArray(body.models) ? body.models : [];
      const [connections, combos] = await Promise.all([
        getProviderConnections({ isActive: true }),
        getCombos(),
      ]);
      const unavailableModels = findUnavailableClaudeCatalogModels(models, connections, combos);
      if (unavailableModels.length > 0) {
        return NextResponse.json({
          error: "Some selected models use providers or combos that are no longer available.",
          invalidModels: unavailableModels,
        }, { status: 400 });
      }
      profile = buildClaudeFullCatalogProfile({
        baseUrl: body.baseUrl,
        gatewayKey: body.gatewayKey,
        models,
        pickerLabels: body.pickerLabels ?? {},
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid full-catalog profile" },
        { status: 400 },
      );
    }
    await replaceCliFiles([{
      filePath: getClaudeFullCatalogProfilePath(),
      content: JSON.stringify(profile, null, 2),
      secret: true,
    }]);
    return NextResponse.json({
      success: true,
      ...responseBody(await readProfile()),
      message: "Catalog saved. Exit and relaunch claude-switchboard to refresh /model.",
    });
  } catch (error) {
    console.log("Error writing Claude full-catalog profile:", error);
    return NextResponse.json({ error: "Failed to save Claude full-catalog profile" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await replaceCliFiles([{
      filePath: getClaudeFullCatalogProfilePath(),
      content: null,
      secret: true,
    }]);
    return NextResponse.json({
      success: true,
      ...responseBody({
        configured: false,
        baseUrl: null,
        gatewayKeyFingerprint: "",
        models: [],
        pickerLabels: {},
      }),
      message: "Full Switchboard catalog profile removed",
    });
  } catch (error) {
    console.log("Error removing Claude full-catalog profile:", error);
    return NextResponse.json({ error: "Failed to remove Claude full-catalog profile" }, { status: 500 });
  }
}
