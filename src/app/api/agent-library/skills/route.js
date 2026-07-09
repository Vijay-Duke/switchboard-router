// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  resolveLibraryRoot,
  listLibrarySkills,
  ensureProductSkillsInLibrary,
  installSkillMarkdown,
  removeLibrarySkill,
} from "@/lib/agent-library/index.js";

async function activeRoot() {
  const settings = await loadSettings();
  return { root: resolveLibraryRoot(settings), settings };
}

export async function GET() {
  try {
    const { root, settings } = await activeRoot();
    if (settings.includeProductSkills) {
      await ensureProductSkillsInLibrary(root);
    }
    const skills = await listLibrarySkills(root);
    return NextResponse.json({ skills, libraryRoot: root });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { root } = await activeRoot();

    if (body.action === "ensure_product") {
      const res = await ensureProductSkillsInLibrary(root, { force: !!body.force });
      return NextResponse.json(res);
    }

    if (body.markdown && body.id) {
      const installed = await installSkillMarkdown(root, {
        id: body.id,
        markdown: body.markdown,
        source: body.source || "manual",
      });
      return NextResponse.json({ ok: true, ...installed });
    }

    return NextResponse.json({ error: "id + markdown or action required" }, { status: 400 });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { root } = await activeRoot();
    const res = await removeLibrarySkill(root, id);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
