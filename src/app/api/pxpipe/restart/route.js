// @ts-check
import { NextResponse } from "next/server";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST() {
  try {
    unloadPxpipe();
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error", code: /** @type {any} */ (error)?.code || null },
      { status: 500 }
    );
  }
}
