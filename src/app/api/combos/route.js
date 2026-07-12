// @ts-check
import { NextResponse } from "next/server";
import { getCombos } from "@/lib/db/index.js";
import { ComboWriteError, createComboWrite } from "@/lib/combos/comboWrites.js";

export const dynamic = "force-dynamic";

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const combo = await createComboWrite(body);
    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    if (error instanceof ComboWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
