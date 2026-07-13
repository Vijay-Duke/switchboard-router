// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  resolveLibraryRoot,
  checkSkillUpdates,
  previewSkillUpdate,
  updateSkillFromSource,
} from "@/lib/agent-library/index.js";

async function activeRoot() {
  const settings = await loadSettings();
  return resolveLibraryRoot(settings);
}

export async function GET() {
  try {
    const root = await activeRoot();
    const res = await checkSkillUpdates(root);
    return NextResponse.json(res);
  } catch (e) {
    return jsonError(500, safeErrorMessage(e, "update check failed"));
  }
}

/**
 * POST { action: "preview"|"update", skillId, confirmed?, expectedHash? }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const root = await activeRoot();
    const skillId = body.skillId || body.id;
    if (!skillId) {
      return NextResponse.json({ error: "skillId required" }, { status: 400 });
    }

    if (body.action === "preview") {
      const res = await previewSkillUpdate(root, skillId);
      return NextResponse.json(res, { status: res.ok ? 200 : 400 });
    }

    if (body.action === "update") {
      const res = await updateSkillFromSource(root, skillId, {
        // strict — no !! coercion; "false"/1 must not pass the gate
        confirmed: body.confirmed === true,
        expectedHash: body.expectedHash,
      });
      return NextResponse.json(res, { status: res.ok ? 200 : 400 });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e, "update failed"));
  }
}
