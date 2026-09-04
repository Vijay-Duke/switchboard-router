// @ts-check
import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** @param {URLSearchParams} searchParams */
function getLimit(searchParams) {
  const raw = searchParams.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const logs = await getRecentLogs(getLimit(searchParams));
    return NextResponse.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
