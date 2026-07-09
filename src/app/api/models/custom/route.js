// @ts-check
import { NextResponse } from "next/server";
import {
  getCustomModels,
  addCustomModel,
  addCustomModelsBulk,
  deleteCustomModel,
} from "@/models";

export const dynamic = "force-dynamic";

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add one model, or bulk { models: [...] }
export async function POST(request) {
  try {
    const body = await request.json();

    // Bulk import: { models: [{ providerAlias, id, type?, name? }, ...] }
    if (Array.isArray(body?.models)) {
      if (body.models.length === 0) {
        return NextResponse.json({ success: true, added: 0, skipped: 0 });
      }
      const cleaned = body.models
        .map((m) => ({
          providerAlias: m?.providerAlias,
          id: typeof m?.id === "string" ? m.id.trim() : "",
          type: m?.type || m?.kind || "llm",
          name: m?.name,
        }))
        .filter((m) => m.providerAlias && m.id);
      const result = await addCustomModelsBulk(cleaned);
      return NextResponse.json({ success: true, ...result });
    }

    const { providerAlias, id, type, name } = body || {};
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
