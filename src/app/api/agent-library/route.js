// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  getOverview,
  loadSettings,
  saveSettings,
  resolveLibraryRoot,
} from "@/lib/agent-library/index.js";

/** GET overview: settings, skills, mcp, state */
export async function GET() {
  try {
    const settings = await loadSettings();
    const overview = await getOverview(settings);
    return NextResponse.json(overview);
  } catch (e) {
    console.error("[agent-library] GET", e);
    return jsonError(500, safeErrorMessage(e, "Failed to load agent library"));
  }
}

/** PATCH settings */
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await saveSettings(null, {
      ...body,
      confirmAllowOverwrite: body.confirmAllowOverwrite,
    });
    const root = resolveLibraryRoot(settings);
    return NextResponse.json({ ok: true, settings, libraryRoot: root });
  } catch (e) {
    console.error("[agent-library] PATCH", e);
    return jsonError(500, safeErrorMessage(e, "Failed to save settings"));
  }
}
