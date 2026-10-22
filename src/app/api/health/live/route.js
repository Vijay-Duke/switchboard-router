// @ts-check
import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/** Process liveness for the CLI watchdog — no DB or heavy work on the hot path. */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, live: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
