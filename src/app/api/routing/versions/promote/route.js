// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError.js";
import { promoteLearningVersion } from "@/lib/db/repos/routingRepo.js";

/** POST { id: string } */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const version = await promoteLearningVersion(body.id);
    if (!version) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
