// @ts-check
import { NextResponse } from "next/server";
import { readLocalCursorCredentials } from "@/lib/oauth/cursorLocalCredentials";

/** GET /api/oauth/cursor/auto-import */
export async function GET() {
  try {
    const result = await readLocalCursorCredentials();
    return NextResponse.json(result, result.error === "Unsupported platform" ? { status: 400 } : undefined);
  } catch (error) {
    console.log("Cursor auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
