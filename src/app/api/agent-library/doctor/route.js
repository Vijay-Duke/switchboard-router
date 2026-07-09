// @ts-check
import { NextResponse } from "next/server";
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
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
