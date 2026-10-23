// @ts-check
import { NextResponse } from "next/server";
import {
  getDbReadinessFromHeartbeat,
  startDbHealthHeartbeat,
} from "@/lib/db/dbHealthHeartbeat.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Reads the DB, so it must never be prerendered (see driver.js isBuildPhase guard).
export const dynamic = "force-dynamic";

startDbHealthHeartbeat();

export async function GET() {
  const dbReady = getDbReadinessFromHeartbeat();
  if (!dbReady) {
    // Degraded readiness for operators; the CLI watchdog uses /api/health/live.
    return NextResponse.json({ ok: false, error: "db", live: true }, { status: 503, headers: CORS_HEADERS });
  }
  return NextResponse.json({ ok: true, live: true, db: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
