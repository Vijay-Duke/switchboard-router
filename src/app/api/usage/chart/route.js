// @ts-check
import { NextResponse } from "next/server";
import { getChartData } from "@/lib/db/index.js";
import { DEFAULT_PERIOD, VALID_PERIODS } from "../_lib/periods.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || DEFAULT_PERIOD;

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    // getChartData falls through to its widest (60-bucket) window for "all".
    const data = await getChartData(period);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
