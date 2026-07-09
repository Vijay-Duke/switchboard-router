// @ts-check
import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/jsonError.js";
import { stopHeadroomProxy } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return NextResponse.json({ ...result }, { status });
  } catch (error) {
    return NextResponse.json({ error: safeErrorMessage(error), code: error?.code || null }, { status: 500 });
  }
}
