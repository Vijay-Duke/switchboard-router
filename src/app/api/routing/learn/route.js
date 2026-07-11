// @ts-check
import { NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/jsonError.js";
import { runOptimizer } from "open-sse/routing/optimizer.js";
import { getSettings } from "@/lib/db/index.js";

/**
 * POST /api/routing/learn
 * Body: { comboName: string, force?: boolean }
 * Local-only via dashboardGuard (SPEC §12).
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const comboName = body.comboName || body.combo;
    if (!comboName || typeof comboName !== "string") {
      return NextResponse.json({ error: "comboName required" }, { status: 400 });
    }

    const settings = await getSettings();
    const strat = settings?.comboStrategies?.[comboName] || {};
    if (strat.freezeLearning && !body.force) {
      return NextResponse.json(
        { ok: false, message: "Learning is frozen for this combo", freezeLearning: true },
        { status: 409 }
      );
    }

    const minEvents = strat.autoTuning?.minEventsBeforeLearn ?? 50;
    const windowDays = strat.learningWindowDays ?? 14;
    const maxFewShots = strat.autoTuning?.maxFewShots ?? 5;
    const objective = strat.objective || "balanced";
    // Current combo models so learn drops removed workers from bandit/rules
    let pool = null;
    try {
      const { getComboModels } = await import("@/sse/services/model.js");
      const models = await getComboModels(comboName);
      const router = strat.routerModel;
      pool = (models || []).filter((m) => m && m !== router);
    } catch {
      pool = null;
    }

    const result = await runOptimizer(comboName, {
      force: !!body.force,
      source: "manual",
      minEvents,
      windowDays,
      maxFewShots,
      objective,
      pool,
      log: {
        info: (tag, msg) => console.log(`[${tag}] ${msg}`),
        warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
      },
    });

    return NextResponse.json(result);
  } catch (e) {
    const message = safeErrorMessage(e, "learn_failed");
    console.error("[ROUTING_LEARN] learn_failed:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
