// @ts-check
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Watchdog readiness probe (S7): the launcher restarts the server after 3
// consecutive non-healthy probes, so a wedged DB must surface here instead of
// reporting ok while every /v1 and dashboard route 500s.
const DB_PROBE_TIMEOUT_MS = 2000;

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
  if (!(await isDbReady())) {
    return NextResponse.json({ ok: false, error: "db" }, { status: 503, headers: CORS_HEADERS });
  }
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
