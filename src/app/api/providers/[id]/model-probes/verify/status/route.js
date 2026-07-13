// @ts-check
import { NextResponse } from "next/server";
import { getVerifyStatus } from "@/lib/model-probe/verifyJob.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const snapshot = getVerifyStatus(id);
  return NextResponse.json(snapshot || { status: "idle" }, { headers: { "Cache-Control": "no-store" } });
}
