import { NextResponse } from "next/server";
import {
  getClusterWorkerStats,
  getModelPerfStats,
  getRoutingEvents,
  listLearningVersions,
  getPromotedLearningVersion,
  countRoutingEvents,
  countRoutingAttempts,
  getScoreTrendByDay,
} from "@/lib/db/repos/routingRepo.js";
import { getSettings } from "@/lib/localDb";

/**
 * GET /api/routing/insights?combo=auto&days=14&cluster=&worker=&exploration=1
 * Days default to combo learningWindowDays when set.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const combo = searchParams.get("combo") || searchParams.get("comboName");
    if (!combo) {
      return NextResponse.json({ error: "combo required" }, { status: 400 });
    }

    const settings = await getSettings();
    const strat = settings?.comboStrategies?.[combo] || {};
    const minEvents = strat.autoTuning?.minEventsBeforeLearn ?? 50;
    const defaultDays = strat.learningWindowDays ?? 14;

    const days = Math.min(
      90,
      Math.max(1, Number(searchParams.get("days")) || defaultDays)
    );
    const clusterFilter = searchParams.get("cluster") || "";
    const workerFilter = searchParams.get("worker") || "";
    const explorationOnly =
      searchParams.get("exploration") === "1" ||
      searchParams.get("exploration") === "true";

    // Windowed request count must match optimizer (countRoutingEvents terminal/request-level)
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [
      heatmap,
      modelStats,
      recentRaw,
      versions,
      promoted,
      eventCount,
      attemptCount,
      scoreTrend,
    ] = await Promise.all([
      getClusterWorkerStats(combo, days),
      getModelPerfStats(combo, days),
      getRoutingEvents(combo, { days, limit: 200, terminalOnly: true }),
      listLearningVersions(combo, 15),
      getPromotedLearningVersion(combo),
      countRoutingEvents(combo, since),
      countRoutingAttempts(combo, since),
      getScoreTrendByDay(combo, days),
    ]);

    let recent = recentRaw || [];
    if (clusterFilter) {
      recent = recent.filter((e) => e.cluster === clusterFilter);
    }
    if (workerFilter) {
      recent = recent.filter((e) => e.pickedWorker === workerFilter);
    }
    const explorationLog = recent.filter((e) => e.meta?.exploration);
    if (explorationOnly) {
      recent = explorationLog;
    }
    // Cap table size after filters
    recent = recent.slice(0, 50);

    // Heatmap cells: avg score + wins by cluster × worker
    const workers = [...new Set(heatmap.map((r) => r.pickedWorker).filter(Boolean))];
    const clusters = [...new Set(heatmap.map((r) => r.cluster).filter(Boolean))];
    const cellMap = {};
    for (const r of heatmap) {
      const n = Number(r.n) || 0;
      const wins = Number(r.wins) || 0;
      cellMap[`${r.cluster}|${r.pickedWorker}`] = {
        avg: r.avgScore,
        n,
        wins,
        winRate: n > 0 ? Math.min(1, wins / n) : 0,
      };
    }

    return NextResponse.json({
      combo,
      days,
      /** Request-level count (terminal / DISTINCT requestId) — matches minEvents gate */
      eventCount,
      /** Raw attempt rows including intermediate fallback failures */
      attemptCount,
      minEventsBeforeLearn: minEvents,
      needMore: Math.max(0, minEvents - eventCount),
      strategy: {
        routerModel: strat.routerModel || null,
        objective: strat.objective || "balanced",
        learningEnabled: strat.learningEnabled !== false,
        freezeLearning: !!strat.freezeLearning,
        learningWindowDays: strat.learningWindowDays ?? 14,
        autoLearnIntervalHours: strat.autoLearnIntervalHours ?? 0,
        // Effective rate is clamped to [0, 0.2] at runtime (EXPLORATION_RATE_CAP)
        explorationRate: strat.explorationRate ?? 0.05,
        explorationRateCap: 0.2,
        maxFewShots: strat.autoTuning?.maxFewShots ?? 5,
        activeLearningVersionId: strat.activeLearningVersionId || null,
      },
      promoted,
      versions,
      workers,
      clusters,
      heatmap: clusters.map((cluster) => ({
        cluster,
        cells: workers.map((w) => {
          const c = cellMap[`${cluster}|${w}`];
          return {
            worker: w,
            avg: c?.avg ?? null,
            n: c?.n ?? 0,
            wins: c?.wins ?? 0,
            winRate: c?.winRate ?? 0,
          };
        }),
      })),
      modelStats,
      recent,
      explorationLog: explorationLog.slice(0, 50),
      scoreTrend,
      filters: {
        cluster: clusterFilter || null,
        worker: workerFilter || null,
        explorationOnly,
      },
      notes: {
        eventCountScope:
          "eventCount is request-level (terminal rows / distinct requestId). Heuristic and single-worker shortcuts are not logged and do not appear here.",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message || "insights_failed" }, { status: 500 });
  }
}
