// @ts-check
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Must exceed SQLite busy_timeout (5000ms in schema.js) so a legitimately
// waiting connection is not reported dead while locks clear.
const DB_PROBE_TIMEOUT_MS = 6000;

// Reads the DB, so it must never be prerendered (see driver.js isBuildPhase guard).
export const dynamic = "force-dynamic";

async function isDbReady() {
  try {
    const probe = (async () => {
      const db = await getAdapter();
      await db.get("SELECT 1");
    })();
    await Promise.race([
      probe,
      new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timeout")), DB_PROBE_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const dbReady = await isDbReady();
  if (!dbReady) {
    // Degraded readiness for operators; the CLI watchdog uses /api/health/live.
    return NextResponse.json({ ok: false, error: "db", live: true }, { status: 503, headers: CORS_HEADERS });
  }
  return NextResponse.json({ ok: true, live: true, db: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
