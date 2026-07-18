// @ts-check
import { NextResponse } from "next/server";
import { generateClaudePickerLabels } from "@/lib/cli/claudePickerLabels.js";

export const dynamic = "force-dynamic";

/**
 * POST /api/cli-tools/claude-picker-labels
 * Suggest short Claude /model picker labels for catalog entries.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const modelIds = Array.isArray(body?.modelIds) ? body.modelIds : [];
    if (modelIds.length === 0) {
      return NextResponse.json({ error: "At least one model ID is required" }, { status: 400 });
    }
    if (modelIds.length > 40) {
      return NextResponse.json({ error: "Label at most 40 models per request" }, { status: 400 });
    }

    const { labels, source } = await generateClaudePickerLabels({
      modelIds,
      namingModel: typeof body?.namingModel === "string" ? body.namingModel : "",
      existingLabels: body?.existingLabels && typeof body.existingLabels === "object"
        ? body.existingLabels
        : {},
    });

    return NextResponse.json({
      labels,
      source,
      usedNamingModel: source === "ai",
    });
  } catch (error) {
    console.log("Error generating Claude picker labels:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate picker labels" },
      { status: 500 },
    );
  }
}
