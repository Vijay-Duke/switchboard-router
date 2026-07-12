import { recordRatingForRelearn } from "open-sse/routing/feedbackRelearn.js";
import { runOptimizer } from "open-sse/routing/optimizer.js";
import { getSettings } from "@/lib/db/index.js";
import { getComboModels } from "@/sse/services/model.js";

const DEBOUNCE_MS = 60000;
const timers = Object.create(null);

export function maybeScheduleRelearn(comboName) {
  try {
    if (!comboName) return;
    if (!recordRatingForRelearn(comboName)) return;
    if (timers[comboName]) clearTimeout(timers[comboName]);
    timers[comboName] = setTimeout(() => runFeedbackRelearn(comboName), DEBOUNCE_MS);
    if (typeof timers[comboName].unref === "function") timers[comboName].unref();
  } catch {
    /* fail-open */
  }
}

async function runFeedbackRelearn(comboName) {
  delete timers[comboName];
  try {
    const settings = await getSettings();
    const strat = settings?.comboStrategies?.[comboName] || {};
    if (strat.fallbackStrategy !== "auto") return;
    if (strat.freezeLearning) return;
    if (strat.learningEnabled === false) return;
    if (!strat.routerModel) return;

    let pool = null;
    try {
      const models = await getComboModels(comboName);
      pool = (models || []).filter((m) => m && m !== strat.routerModel);
    } catch {
      pool = null;
    }

    await runOptimizer(comboName, {
      force: false,
      source: "feedback",
      minEvents: strat.autoTuning?.minEventsBeforeLearn ?? 50,
      windowDays: strat.learningWindowDays ?? 14,
      maxFewShots: strat.autoTuning?.maxFewShots ?? 5,
      objective: strat.objective || "balanced",
      pool,
      log: {
        info: (t, m) => console.log(`[${t}] ${m}`),
        warn: (t, m) => console.warn(`[${t}] ${m}`),
      },
    });
  } catch (e) {
    console.warn("[ROUTING_LEARN] feedback relearn failed:", e?.message || e);
  }
}
