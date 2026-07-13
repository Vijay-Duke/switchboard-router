// @ts-check
import { NextResponse } from "next/server";
import { getVaultStats } from "open-sse/rtk/vaultStats.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

export async function GET() {
  return NextResponse.json(getVaultStats(), { headers: RESPONSE_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: RESPONSE_HEADERS });
}
