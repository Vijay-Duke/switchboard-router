import { getRoutingEventByRequestId } from "@/lib/db/repos/routingRepo.js";
import { applyRatingOverlay } from "open-sse/routing/overlay.js";
import { invalidateCachedRoutes } from "open-sse/routing/handleAutoChat.js";
import { armEscalation } from "open-sse/routing/judge.js";
import { maybeScheduleRelearn } from "./feedbackRelearn.js";

/**
 * Apply non-persistent routing reactions after a stored user rating. Best-effort:
 * feedback persistence succeeds independently if any of these reactions fail.
 */
export async function applyRatingSideEffects(requestId, rating) {
  try {
    if (!requestId || rating == null) return;
    const event = await getRoutingEventByRequestId(requestId);
    if (!event?.comboName || !event?.cluster || !event?.pickedWorker) return;

    applyRatingOverlay(event.comboName, event.cluster, event.pickedWorker, rating);
    if (Number(rating) < 0) {
      invalidateCachedRoutes(event.comboName);
      armEscalation(event.comboName, event.cluster);
    }
    maybeScheduleRelearn(event.comboName);
  } catch {
    /* fail-open */
  }
}
