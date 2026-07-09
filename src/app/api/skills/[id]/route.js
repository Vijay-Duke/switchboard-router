// @ts-check
import { NextResponse } from "next/server";
import { readSkillMarkdown, rewriteSkillUrls } from "@/lib/skills/paths.js";

/**
 * GET /api/skills/:id
 * Serves skills/<id>/SKILL.md as text/markdown for agents and the dashboard viewer.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const raw = await readSkillMarkdown(id);
    if (raw == null) {
      return NextResponse.json(
        { error: "Skill not found", id },
        { status: 404 }
      );
    }

    const origin = new URL(request.url).origin;
    const body = rewriteSkillUrls(raw, origin);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        // Allow agents / other origins to fetch skill docs
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    console.error("[skills] GET failed:", e);
    return NextResponse.json(
      { error: e?.message || "Failed to load skill" },
      { status: 500 }
    );
  }
}
