// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  runDoctor,
} from "@/lib/agent-library/index.js";

export async function GET() {
  try {
    const settings = await loadSettings();
    const report = await runDoctor(settings);
    return NextResponse.json(report);
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
