// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  resolveLibraryRoot,
  CATALOG_PRESETS,
  installFromUrl,
  previewUrl,
} from "@/lib/agent-library/index.js";

async function activeRootAndSettings() {
  const settings = await loadSettings();
  return { root: resolveLibraryRoot(settings), settings };
}

export async function GET() {
  return NextResponse.json({ presets: CATALOG_PRESETS });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { root, settings } = await activeRootAndSettings();

    if (body.action === "preview" && body.url) {
      const res = await previewUrl(body.url);
      return NextResponse.json(res);
    }

    if (body.action === "install") {
      const skillId = body.skillId || body.id;
      const url = body.url;
      if (!skillId || !url) {
        return NextResponse.json(
          { error: "skillId and url required" },
          { status: 400 }
        );
      }
      const res = await installFromUrl(root, {
        skillId,
        url,
        confirmed: !!body.confirmed,
        requireConfirm: settings.requireCatalogConfirm !== false,
      });
      const status = res.ok ? 200 : res.error === "confirmation_required" ? 400 : 400;
      return NextResponse.json(res, { status });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
