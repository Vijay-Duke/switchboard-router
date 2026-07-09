// @ts-check
import { NextResponse } from "next/server";
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
    return NextResponse.json(
      { error: e?.message || "Failed to load agent library" },
      { status: 500 }
    );
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
    return NextResponse.json(
      { error: e?.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}
