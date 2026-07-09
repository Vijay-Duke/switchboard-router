// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError.js";
import { rollbackLearningVersion } from "@/lib/db/repos/routingRepo.js";

/** POST { comboName: string } */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const comboName = body.comboName || body.combo;
    if (!comboName) {
      return NextResponse.json({ error: "comboName required" }, { status: 400 });
    }
    const version = await rollbackLearningVersion(comboName);
    if (!version) {
      return NextResponse.json(
        { error: "nothing to rollback", ok: false },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
