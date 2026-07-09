// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  applySync,
  cleanSync,
} from "@/lib/agent-library/index.js";

async function getSettings() {
  return loadSettings();
}

/**
 * POST { action: "apply"|"dry-run"|"clean", skillsOnly?, mcpOnly? }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();
    const action = body.action || "apply";

    if (action === "clean") {
      if (!body.confirm) {
        return NextResponse.json(
          {
            error: "confirmation_required",
            message: "Clean removes Switchboard-managed projections only. Pass confirm: true.",
          },
          { status: 400 }
        );
      }
      const res = await cleanSync(settings);
      return NextResponse.json(res);
    }

    if (action === "dry-run") {
      const res = await applySync(settings, {
        dryRun: true,
        skillsOnly: !!body.skillsOnly,
        mcpOnly: !!body.mcpOnly,
      });
      return NextResponse.json(res);
    }

    // apply
    const res = await applySync(settings, {
      dryRun: false,
      skillsOnly: !!body.skillsOnly,
      mcpOnly: !!body.mcpOnly,
    });
    return NextResponse.json(res);
  } catch (e) {
    console.error("[agent-library/sync]", e);
    return jsonError(500, safeErrorMessage(e, "sync failed"));
  }
}
