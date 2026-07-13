// @ts-check
import { NextResponse } from "next/server";
import { cancelVerify } from "@/lib/model-probe/verifyJob.js";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { id } = await params;
  const cancelled = cancelVerify(id);
  return NextResponse.json({ cancelled });
}
