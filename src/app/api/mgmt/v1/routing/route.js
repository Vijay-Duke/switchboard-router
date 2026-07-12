// @ts-check
import {
  countRoutingAttempts,
  countRoutingEvents,
  getModelPerfStats,
  getScoreTrendByDay,
  listCombosWithRoutingEvents,
} from "@/lib/db/repos/routingRepo.js";
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

const DEFAULT_DAYS = 14;

export const dynamic = "force-dynamic";

/** @param {string|null} value */
function getDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_DAYS;
  return Math.min(90, Math.max(1, days));
}

/** @param {string} combo @param {number} days */
async function getRoutingData(combo, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [modelPerf, eventCount, attemptCount, scoreTrend] = await Promise.all([
    getModelPerfStats(combo, days),
    countRoutingEvents(combo, since),
    countRoutingAttempts(combo, since),
    getScoreTrendByDay(combo, days),
  ]);
  return { modelPerf, eventCount, attemptCount, scoreTrend };
}

/** GET /api/mgmt/v1/routing?combo=name&days=1..90 */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const searchParams = new URL(request.url).searchParams;
    const combo = searchParams.get("combo");
    if (!combo) return ok({ combos: await listCombosWithRoutingEvents() });
    const days = getDays(searchParams.get("days"));
    return ok({ combo, days, ...(await getRoutingData(combo, days)) });
  } catch {
    return fail(500, "Failed to fetch routing");
  }
}
