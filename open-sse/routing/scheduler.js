/**
 * In-process Auto learning scheduler (PHASES.md Phase 3).
 * Runs relearn for combos with autoLearnIntervalHours > 0 and !freezeLearning.
 * Pattern mirrors quotaAutoPing: survive HMR via global singleton.
 *
 * lastRun is persisted via router_learning_versions.source='scheduled'
 * (MAX createdAt) so restarts do not re-arm every combo after BOOT_DELAY.
 */
import { getSettings } from "@/lib/localDb";
import {
  listCombosWithRoutingEvents,
  getLastScheduledLearnAt,
} from "@/lib/db/repos/routingRepo.js";
import { runOptimizer } from "./optimizer.js";

const TICK_MS = 15 * 60 * 1000; // check every 15 minutes
const BOOT_DELAY_MS = 60_000;

const g = (global.__autoLearnScheduler ??= {
  interval: null,
  running: false,
  /** @type {Record<string, number>} in-process cache; seeded from DB */
  lastRunByCombo: {},
});

/**
 * Start the scheduler once per process.
 * @param {{ log?: { info?: Function, warn?: Function, error?: Function } }} [opts]
 */
export function startAutoLearnScheduler(opts = {}) {
  if (g.interval) return;
  const log = opts.log || console;
  const tick = () => {
    runAutoLearnTick(log).catch((e) =>
      log.warn?.("[ROUTING_LEARN] scheduler tick failed:", e?.message || e)
    );
  };
  setTimeout(tick, BOOT_DELAY_MS);
  g.interval = setInterval(tick, TICK_MS);
  if (typeof g.interval.unref === "function") g.interval.unref();
  log.info?.("[ROUTING_LEARN] scheduler started (tick every 15m)");
}

export function stopAutoLearnScheduler() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
}

/**
 * Resolve last scheduled run ms for a combo (memory, then DB).
 * @param {string} comboName
 */
async function resolveLastRunMs(comboName) {
  if (g.lastRunByCombo[comboName]) return g.lastRunByCombo[comboName];
  try {
    const iso = await getLastScheduledLearnAt(comboName);
    if (iso) {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) {
        g.lastRunByCombo[comboName] = ms;
        return ms;
      }
    }
  } catch {
    /* ignore — treat as never ran */
  }
  return 0;
}

/**
 * One scheduler pass — exported for tests.
 * @param {object} [log]
 */
export async function runAutoLearnTick(log = console) {
  if (g.running) return { skipped: true, reason: "already_running" };
  g.running = true;
  try {
    const settings = await getSettings();
    const strategies = settings?.comboStrategies || {};
    // Prefer combos that already have events; also scan strategy keys with interval set
    const fromEvents = await listCombosWithRoutingEvents().catch(() => []);
    const fromSettings = Object.keys(strategies).filter(
      (n) => strategies[n]?.fallbackStrategy === "auto"
    );
    const names = [...new Set([...fromEvents, ...fromSettings])];

    const results = [];
    const now = Date.now();

    for (const comboName of names) {
      const strat = strategies[comboName] || {};
      if (strat.fallbackStrategy !== "auto") continue;
      if (strat.learningEnabled === false) continue;
      if (strat.freezeLearning) continue;

      const hours = Number(strat.autoLearnIntervalHours);
      // 0 / missing / NaN = manual only
      if (!Number.isFinite(hours) || hours <= 0) continue;

      const intervalMs = hours * 3600 * 1000;
      const last = await resolveLastRunMs(comboName);
      if (last > 0 && now - last < intervalMs) continue;

      const minEvents = strat.autoTuning?.minEventsBeforeLearn ?? 50;
      const windowDays = strat.learningWindowDays ?? 14;
      const maxFewShots = strat.autoTuning?.maxFewShots ?? 5;
      const objective = strat.objective || "balanced";

      try {
        // Resolve current worker pool for filtering removed models from bandit
        let pool = null;
        try {
          const { getComboModels } = await import("@/sse/services/model.js");
          const models = await getComboModels(comboName);
          const router = strat.routerModel || "claude/claude-opus-4-8";
          pool = (models || []).filter((m) => m && m !== router);
        } catch {
          pool = null;
        }
        const result = await runOptimizer(comboName, {
          force: false,
          source: "scheduled",
          minEvents,
          windowDays,
          maxFewShots,
          objective,
          pool,
          log: {
            info: (tag, msg) => log.info?.(`[${tag}] ${msg}`),
            warn: (tag, msg) => log.warn?.(`[${tag}] ${msg}`),
          },
        });
        // Only advance last-run when we actually attempted a learn cycle
        // (ok or explicit no-improvement / insufficient — not transport errors)
        g.lastRunByCombo[comboName] = now;
        results.push({ comboName, ...result });
        if (result.ok) {
          log.info?.(
            "[ROUTING_LEARN]",
            `scheduled ${comboName}: ${result.message}`
          );
        }
      } catch (e) {
        log.error?.("[ROUTING_LEARN]", `scheduled ${comboName} failed: ${e.message}`);
        results.push({ comboName, ok: false, error: e.message });
      }
    }

    return { ok: true, results };
  } finally {
    g.running = false;
  }
}
