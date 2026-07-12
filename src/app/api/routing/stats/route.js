// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError.js";
import {
  getClusterWorkerStats,
  getComboScoreTimeline,
  getGlobalModelStats,
  getJudgeCoverage,
  getPickSourceCounts,
} from "@/lib/db/repos/routingRepo.js";
import { cached } from "open-sse/routing/routingCache.js";

/** GET /api/routing/stats?combo=auto&days=14 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const combo = searchParams.get("combo");
    const days = Math.min(90, Math.max(1, Number(searchParams.get("days")) || 14));
    // Distinct "rvstats:" namespace — the plain "stats:<combo>:<days>" keyspace is
    // used elsewhere (statsCacheKey), so a combo literally named "global" would
    // otherwise collide with the global-stats key.
    const global = await cached(
      `rvstats:global:${days}`,
      () => getGlobalModelStats(days),
      15000
    );
    const [timeline, pickSource, heatmap, judgeCoverage] = combo
      ? await Promise.all([
          cached(
            `rvstats:timeline:${combo}:${days}`,
            () => getComboScoreTimeline(combo, days),
            15000
          ),
          cached(
            `rvstats:picksrc:${combo}:${days}`,
            () => getPickSourceCounts(combo, days),
            15000
          ),
          cached(
            `rvstats:heatmap:${combo}:${days}`,
            () => getClusterWorkerStats(combo, days),
            15000
          ),
          cached(
            `rvstats:judge:${combo}:${days}`,
            () => getJudgeCoverage(combo, days),
            15000
          ),
        ])
      : [[], null, [], null];

    return NextResponse.json({
      days,
      global,
      combo: combo || null,
      timeline,
      pickSource,
      heatmap,
      judgeCoverage,
    });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e, "stats_failed"));
  }
}
