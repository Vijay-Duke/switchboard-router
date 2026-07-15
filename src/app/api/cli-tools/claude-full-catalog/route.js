// @ts-check
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir.js";
import { replaceCliFiles } from "@/lib/cli/fileIo.js";
import {
  buildClaudeFullCatalogProfile,
  hasClaudeFullCatalogHeader,
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
    return {
      configured: Boolean(
        env.ANTHROPIC_BASE_URL
        && env.ANTHROPIC_AUTH_TOKEN
        && env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
        && hasClaudeFullCatalogHeader(env.ANTHROPIC_CUSTOM_HEADERS),
      ),
      baseUrl: typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null,
      models: readClaudeCatalogSelectionFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { configured: false, baseUrl: null, models: [] };
    }
    throw error;
  }
};

const responseBody = (status) => ({
  ...status,
  launcher: "claude-switchboard",
  settingsPath: getClaudeFullCatalogProfilePath(),
});

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
      profile = buildClaudeFullCatalogProfile({
        baseUrl: body.baseUrl,
        gatewayKey: body.gatewayKey,
        models: body.models ?? [],
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
      message: "Full Switchboard catalog profile saved",
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
      ...responseBody({ configured: false, baseUrl: null, models: [] }),
      message: "Full Switchboard catalog profile removed",
    });
  } catch (error) {
    console.log("Error removing Claude full-catalog profile:", error);
    return NextResponse.json({ error: "Failed to remove Claude full-catalog profile" }, { status: 500 });
  }
}
