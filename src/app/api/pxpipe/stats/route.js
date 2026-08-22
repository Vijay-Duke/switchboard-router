// @ts-check
import { NextResponse } from "next/server";
import { getPxpipeStats } from "@/lib/pxpipe/events.js";

export const dynamic = "force-dynamic";

/** @param {Request} request */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return NextResponse.json(getPxpipeStats({ recentLimit }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: 500 });
  }
}
