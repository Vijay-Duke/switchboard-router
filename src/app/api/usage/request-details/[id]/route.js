// @ts-check
import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/db/index.js";

/**
 * GET /api/usage/request-details/[id]
 * Returns the single unredacted request-detail row for the dashboard's
 * request inspector drawer. The list route redacts conversation payloads;
 * this route returns the full row so the drawer can show request content.
 *
 * Local-only: served under /api/*, so the proxy guard already restricts callers
 * to loopback / CLI token (client-side integrations run locally).
 * @param {Request} request - Incoming request (unused).
 * @param {{ params: Promise<{ id: string }> }} context - Route params.
 * @returns {Promise<Response>} The unredacted detail row, or 404 when unknown.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json(
        { error: "Request detail not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ detail });
  } catch (error) {
    console.error("[API] Failed to get request detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch request detail" },
      { status: 500 }
    );
  }
}
