// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError.js";
import { setUserRatingByRequestId } from "@/lib/db/repos/routingRepo.js";

/**
 * POST /api/routing/feedback
 * Body: { requestId: string, rating: 1 | -1 | 0 }
 *
 * Sets the user rating on the terminal routing event(s) for a request and
 * recomputes the stored outcomeScore (±25; 0 clears). An explicit rating
 * overrides any prior LLM-judge adjustment on the same event.
 *
 * Local-only: served under /api/*, so the proxy guard already restricts callers
 * to loopback / CLI token (client-side integrations run locally).
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) {
      return NextResponse.json({ error: "requestId required" }, { status: 400 });
    }
    const rating = Number(body.rating);
    if (![1, -1, 0].includes(rating)) {
      return NextResponse.json(
        { error: "rating must be 1, -1, or 0" },
        { status: 400 }
      );
    }

    const result = await setUserRatingByRequestId(requestId, rating);
    if (!result.updated) {
      return NextResponse.json(
        { error: "unknown requestId (no terminal event found)" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, updated: result.updated, rating });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e, "feedback_failed"));
  }
}
