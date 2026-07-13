// @ts-check
import { NextResponse } from "next/server";
import { cancelVerify } from "@/lib/model-probe/verifyJob.js";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  try {
    const { id } = await params;
    const cancelled = cancelVerify(id);
    return NextResponse.json({ cancelled });
  } catch (error) {
    console.log("Error cancelling verify job:", error);
    return NextResponse.json({ error: "Failed to cancel verify" }, { status: 500 });
  }
}
