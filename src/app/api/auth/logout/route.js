// @ts-check
import { NextResponse } from "next/server";
import { DASHBOARD_SESSION_COOKIE } from "@/lib/auth/dashboardSession.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** POST — clear the dashboard session cookie (idempotent). */
export async function POST() {
  return NextResponse.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    },
  );
}
