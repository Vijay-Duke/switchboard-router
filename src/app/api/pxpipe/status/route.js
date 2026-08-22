// @ts-check
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const status = getPxpipeStatus();
    return NextResponse.json({
      ...status,
      enabled: !!settings.pxpipeEnabled,
      autoInstall: !!settings.pxpipeAutoInstall,
      minChars: settings.pxpipeMinChars,
      timeoutMs: settings.pxpipeTimeoutMs,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
  }
}
