/**
 * Learning optimizer — bandit table, rules, few-shots, eval gate.
 * docs/switchboard/LEARNING.md + PHASES.md Phase 2
 */
import {
  getRoutingEvents,
  getClusterWorkerStats,
  getPromotedLearningVersion,
  createLearningVersion,
  countRoutingEvents,
} from "../runtimeDeps.js";
import { pickByObjective } from "./objective.js";
import { normalizeCluster } from "./taxonomy.js";

const DEFAULT_MAX_FEW_SHOTS = 5;
const RULE_MIN_ATTEMPTS = 10;
const RULE_SCORE_DELTA = 15; // percentage points of avgScore
const RULE_CAP = 10;
const FEW_SHOT_MIN_SCORE = 85;
const EVAL_PROMOTE_MARGIN = 2.0;

/**
 * Run relearn for a combo. Fail-open callers should catch.
 * @param {string} comboName
 * @param {{
 *   force?: boolean,
 *   source?: string,
 *   minEvents?: number,
 *   windowDays?: number,
 *   maxFewShots?: number,
 *   objective?: string,
 *   log?: { info?: Function, warn?: Function, error?: Function },
 * }} opts
 */
export async function runOptimizer(comboName, opts = {}) {
  const minEvents = opts.minEvents ?? 50;
  const windowDays = opts.windowDays ?? 14;
  const source = opts.source || "manual";
  const maxFewShots = opts.maxFewShots ?? DEFAULT_MAX_FEW_SHOTS;
  const objective = opts.objective || "balanced";
  const log = opts.log;
  /** Optional current worker pool — filters out removed models from artifacts */
  const poolFilter =
    Array.isArray(opts.pool) && opts.pool.length
      ? new Set(opts.pool.filter(Boolean))
      : null;

  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const eventCount = await countRoutingEvents(comboName, since);
  // force only bypasses min-events (and freeze at API), NOT the eval regression gate
  if (eventCount < minEvents && !opts.force) {
    return {
      ok: false,
      promoted: false,
      reason: "insufficient_events",
      message: `Need ${minEvents - eventCount} more requests before first learn (min ${minEvents})`,
      eventCount,
      minEvents,
    };
  }

  const statsRaw = await getClusterWorkerStats(comboName, windowDays);
  const stats = poolFilter
    ? (statsRaw || []).filter((r) => poolFilter.has(r.pickedWorker))
    : statsRaw;
  const attemptEventsRaw = await getRoutingEvents(comboName, {
    days: windowDays,
    limit: 2000,
    terminalOnly: false,
  });
  const inPool = (e) => !poolFilter || poolFilter.has(e.pickedWorker);
  const attemptEvents = (attemptEventsRaw || []).filter(inPool);
  const terminalEvents = (attemptEvents || []).filter(
    (e) =>
      (e.meta?.terminal === true || e.meta?.terminal == null) &&
      !e.meta?.skippedRouter
  );

  // Artifact bandit: prefer event-built table (real p50) over SQL means
  let banditTable = buildBanditTableFromEvents(attemptEvents);
  if (Object.keys(banditTable).length === 0) {
    banditTable = buildBanditTable(stats);
  }

  if (Object.keys(banditTable).length === 0) {
    return {
      ok: false,
      promoted: false,
      reason: "empty_bandit",
      message:
        "No cluster×worker stats in the learning window — refusing to promote an empty version",
      eventCount,
      minEvents,
    };
  }

  const learnedRules = deriveRules(banditTable);
  const ruleGaps = describeRuleGaps(banditTable);
  const fewShots = pickFewShots(terminalEvents, maxFewShots);

  // ── Fair eval gate ─────────────────────────────────────────────────────
  // Chronological split: fit policy on train only, score train + prev policy
  // on the SAME held-out set (cancels window / policy drift bias).
  const forEval = (terminalEvents || [])
    .filter(
      (e) =>
        e.cluster &&
        e.pickedWorker &&
        e.outcomeScore != null &&
        !e.meta?.skippedRouter
    )
    .slice()
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));

  let trainEvents = forEval;
  let heldOut = forEval;
  if (forEval.length >= 5) {
    const holdN = Math.max(1, Math.floor(forEval.length * 0.3));
    trainEvents = forEval.slice(0, forEval.length - holdN);
    heldOut = forEval.slice(forEval.length - holdN);
  }

  // Train bandit from attempt rows up to train cutoff (richer than terminal-only)
  const trainCutoff =
    trainEvents.length > 0
      ? trainEvents[trainEvents.length - 1].timestamp
      : null;
  const trainAttempts = trainCutoff
    ? (attemptEvents || []).filter(
        (e) =>
          e.timestamp &&
          String(e.timestamp) <= String(trainCutoff) &&
          !e.meta?.skippedRouter
      )
    : attemptEvents || [];

  let trainBandit = buildBanditTableFromEvents(trainAttempts);
  if (Object.keys(trainBandit).length === 0) {
    trainBandit = buildBanditTableFromEvents(trainEvents);
  }
  // If still empty (tiny sample), fall back to full table for eval only
  const evalBandit =
    Object.keys(trainBandit).length > 0 ? trainBandit : banditTable;

  const evalScore = computeReplayEval(evalBandit, heldOut, objective);

  const prev = await getPromotedLearningVersion(comboName);
  const oldEval =
    prev?.banditTable && Object.keys(prev.banditTable).length
      ? computeReplayEval(prev.banditTable, heldOut, objective)
      : null;

  // Promote if first version OR newEval >= oldEval + 2.0 on same held-out.
  // force does NOT bypass the eval gate (SPEC §6: eval regression → do not promote).
  // force only skips minEvents / freezeLearning at the API layer.
  let promote = true;
  let notes = `events=${eventCount}; clusters=${Object.keys(banditTable).length}; objective=${objective}; holdout=${heldOut.length}`;
  if (ruleGaps.length) {
    notes += `; ${ruleGaps.slice(0, 3).join("; ")}`;
  }
  if (oldEval != null) {
    if (evalScore < oldEval + EVAL_PROMOTE_MARGIN) {
      promote = false;
      notes += `; no promote (eval ${evalScore.toFixed(1)} < old ${oldEval.toFixed(1)} + ${EVAL_PROMOTE_MARGIN})`;
      if (opts.force) notes += " (force skipped min-events only)";
    } else {
      notes += `; eval ${evalScore.toFixed(1)} (old ${oldEval.toFixed(1)}, +${(evalScore - oldEval).toFixed(1)})`;
    }
  } else {
    notes += `; eval ${evalScore.toFixed(1)} (first)`;
  }

  const version = await createLearningVersion({
    comboName,
    source,
    banditTable,
    learnedRules,
    fewShots,
    evalScore,
    notes,
    promote,
    prevVersionId: prev?.id || null,
  });

  const msg = promote
    ? `Promoted v${version.version}`
    : `Created v${version.version} but did not promote (no improvement)`;

  log?.info?.(
    "ROUTING_LEARN",
    prev
      ? `v${prev.version}→v${version.version} eval ${oldEval?.toFixed?.(1) ?? "—"}→${evalScore.toFixed(1)} ${promote ? "promoted" : "draft"}`
      : `v${version.version} eval ${evalScore.toFixed(1)} ${promote ? "promoted" : "draft"} (first)`
  );

  return {
    ok: true,
    promoted: promote,
    version: version.version,
    evalScore,
    prevEvalScore: oldEval,
    eventCount,
    message: msg,
    id: version.id,
  };
}

/**
 * Build bandit table from cluster×worker stats rows (SQL aggregates).
 * wins = count where outcomeScore >= 60 (from SQL wins column when present).
 */
export function buildBanditTable(stats) {
  /** @type {Record<string, Record<string, { wins: number, attempts: number, avgScore: number, avgLatencyMs: number, p50LatencyMs: number }>>} */
  const table = {};
  for (const row of stats || []) {
    // Auto v2: fold legacy free-form clusters into the taxonomy so historical
    // SQL aggregates (grouped by raw cluster) merge under the canonical key.
    const c = normalizeCluster(row.cluster);
    const w = row.pickedWorker;
    if (!w) continue;
    if (!table[c]) table[c] = {};
    const n = Number(row.n) || 0;
    const avg = Number(row.avgScore) || 0;
    let wins =
      row.wins != null && Number.isFinite(Number(row.wins))
        ? Number(row.wins)
        : Math.round((avg / 100) * n);
    wins = Math.max(0, Math.min(n, wins));
    const latency = Number(row.avgLatencyMs) || 0;
    const p50 =
      row.p50LatencyMs != null && Number.isFinite(Number(row.p50LatencyMs))
        ? Number(row.p50LatencyMs)
        : latency;
    const prev = table[c][w];
    if (prev) {
      // Two legacy clusters collapsed to the same canonical key — merge weighted.
      const totalN = prev.attempts + n;
      table[c][w] = {
        wins: Math.max(0, Math.min(totalN, prev.wins + wins)),
        attempts: totalN,
        avgScore: totalN ? (prev.avgScore * prev.attempts + avg * n) / totalN : 0,
        avgLatencyMs: totalN
          ? (prev.avgLatencyMs * prev.attempts + latency * n) / totalN
          : 0,
        p50LatencyMs: totalN ? (prev.p50LatencyMs * prev.attempts + p50 * n) / totalN : 0,
      };
    } else {
      table[c][w] = {
        wins,
        attempts: n,
        avgScore: avg,
        avgLatencyMs: latency,
        p50LatencyMs: p50,
      };
    }
  }
  return table;
}

/**
 * Build bandit table from raw routing event rows (for train-split eval).
 * @param {Array} events
 */
export function buildBanditTableFromEvents(events) {
  /** @type {Record<string, Record<string, { scores: number[], wins: number, lats: number[] }>>} */
  const acc = {};
  for (const e of events || []) {
    if (e.meta?.skippedRouter) continue;
    const c = normalizeCluster(e.cluster);
    const w = e.pickedWorker;
    if (!w || e.outcomeScore == null) continue;
    if (!acc[c]) acc[c] = {};
    if (!acc[c][w]) acc[c][w] = { scores: [], wins: 0, lats: [] };
    const cell = acc[c][w];
    const score = Number(e.outcomeScore) || 0;
    cell.scores.push(score);
    if (score >= 60) cell.wins += 1;
    if (e.workerLatencyMs != null && Number.isFinite(Number(e.workerLatencyMs))) {
      cell.lats.push(Number(e.workerLatencyMs));
    }
  }

  /** @type {Record<string, Record<string, object>>} */
  const table = {};
  for (const [c, models] of Object.entries(acc)) {
    table[c] = {};
    for (const [w, cell] of Object.entries(models)) {
      const n = cell.scores.length;
      const avg = n ? cell.scores.reduce((a, b) => a + b, 0) / n : 0;
      const avgLat = cell.lats.length
        ? cell.lats.reduce((a, b) => a + b, 0) / cell.lats.length
        : 0;
      const p50 = percentile(cell.lats, 50);
      table[c][w] = {
        wins: Math.max(0, Math.min(n, cell.wins)),
        attempts: n,
        avgScore: avg,
        avgLatencyMs: avgLat,
        p50LatencyMs: p50 != null ? p50 : avgLat,
      };
    }
  }
  return table;
}

function percentile(values, p) {
  if (!values?.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (p === 50) {
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Derive rules (LEARNING.md):
 * - ≥10 samples per worker considered
 * - best.avgScore - second.avgScore > 15
 * - Cap 10 rules
 */
export function deriveRules(banditTable) {
  const rules = [];
  for (const [cluster, models] of Object.entries(banditTable || {})) {
    const entries = Object.entries(models)
      .map(([id, s]) => ({ id, ...s }))
      .filter((s) => s.attempts >= RULE_MIN_ATTEMPTS)
      .sort((a, b) => b.avgScore - a.avgScore);
    if (!entries.length) continue;
    const best = entries[0];
    const rate = best.attempts ? best.wins / best.attempts : 0;
    if (entries.length >= 2) {
      const second = entries[1];
      if (best.avgScore - second.avgScore > RULE_SCORE_DELTA) {
        rules.push(
          `For cluster "${cluster}", prefer ${best.id} (win rate ${Math.round(rate * 100)}%, n=${best.attempts})`
        );
      }
    } else if (rate >= 0.55) {
      rules.push(
        `For cluster "${cluster}", prefer ${best.id} (win rate ${Math.round(rate * 100)}%, n=${best.attempts})`
      );
    }
    if (entries.length >= 2) {
      const worst = entries[entries.length - 1];
      if (worst.id !== best.id && best.avgScore - worst.avgScore > RULE_SCORE_DELTA) {
        rules.push(
          `Avoid ${worst.id} for "${cluster}" when ${best.id} is available`
        );
      }
    }
  }
  return rules.slice(0, RULE_CAP);
}

/**
 * Human notes when no prefer-rule fires (models too close). Surfaced in version notes + prompt.
 * @param {Record<string, Record<string, object>>} banditTable
 * @returns {string[]}
 */
export function describeRuleGaps(banditTable) {
  const notes = [];
  for (const [cluster, models] of Object.entries(banditTable || {})) {
    const entries = Object.entries(models)
      .map(([id, s]) => ({ id, ...s }))
      .filter((s) => s.attempts >= RULE_MIN_ATTEMPTS)
      .sort((a, b) => b.avgScore - a.avgScore);
    if (entries.length < 2) continue;
    const best = entries[0];
    const second = entries[1];
    const delta = best.avgScore - second.avgScore;
    if (delta <= RULE_SCORE_DELTA) {
      notes.push(
        `no rule: "${cluster}" top two within ${RULE_SCORE_DELTA} pts ` +
          `(${shortId(best.id)}=${Math.round(best.avgScore)} n=${best.attempts}, ` +
          `${shortId(second.id)}=${Math.round(second.avgScore)} n=${second.attempts})`
      );
    }
  }
  return notes;
}

function shortId(id) {
  if (!id) return "?";
  const parts = String(id).split("/");
  return parts[parts.length - 1] || id;
}

/**
 * Few-shots (LEARNING.md):
 * - score >= 85
 * - per cluster
 * - dedupe by fingerprint
 * - top maxFewShots overall (spread across clusters)
 * - summary = first 120 chars of user intent when available
 */
export function pickFewShots(events, max = DEFAULT_MAX_FEW_SHOTS) {
  const cap = Math.max(1, Math.min(20, Number(max) || DEFAULT_MAX_FEW_SHOTS));
  const eligible = (events || []).filter(
    (e) =>
      e.outcomeScore != null &&
      e.outcomeScore >= FEW_SHOT_MIN_SCORE &&
      e.pickedWorker &&
      !e.meta?.skippedRouter
  );

  /** @type {Map<string, typeof eligible>} */
  const byCluster = new Map();
  for (const e of eligible) {
    const c = normalizeCluster(e.cluster);
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(e);
  }

  const selected = [];
  const seenFp = new Set();
  const clusters = [...byCluster.keys()];
  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (const c of clusters) {
      if (selected.length >= cap) break;
      const list = byCluster.get(c) || [];
      list.sort((a, b) => (b.outcomeScore || 0) - (a.outcomeScore || 0));
      while (list.length) {
        const e = list.shift();
        const fp =
          e.requestFingerprint ||
          `${e.cluster}|${e.pickedWorker}|${e.routerReason || ""}`;
        if (seenFp.has(fp)) continue;
        seenFp.add(fp);
        selected.push(mapFewShot(e));
        progressed = true;
        break;
      }
    }
  }

  return selected;
}

function mapFewShot(e) {
  const intent =
    (typeof e.meta?.userSummary === "string" && e.meta.userSummary) ||
    (typeof e.meta?.intentSummary === "string" && e.meta.intentSummary) ||
    "";
  const summary = intent
    ? intent.replace(/\s+/g, " ").trim().slice(0, 120)
    : (e.routerReason || `${e.cluster} → ${e.pickedWorker}`).slice(0, 120);

  return {
    fingerprint: e.requestFingerprint,
    cluster: e.cluster,
    worker: e.pickedWorker,
    score: e.outcomeScore,
    summary,
  };
}

/**
 * Counterfactual replay of a policy on the given events (caller owns train/holdout).
 * Does NOT re-split — pass held-out only for the eval gate.
 * @param {Record<string, Record<string, object>>} banditTable
 * @param {Array} events
 * @param {string} [objective]
 */
export function computeReplayEval(banditTable, events, objective = "balanced") {
  const usable = (events || []).filter(
    (e) =>
      e.cluster &&
      e.pickedWorker &&
      e.outcomeScore != null &&
      !e.meta?.skippedRouter &&
      e.meta?.terminal !== false
  );
  if (!usable.length) {
    return computeTrafficEval(banditTable);
  }

  let total = 0;
  let n = 0;
  for (const e of usable) {
    const cluster = normalizeCluster(e.cluster);
    const models = banditTable[cluster];
    if (!models || !Object.keys(models).length) {
      total += Number(e.outcomeScore) || 0;
      n += 1;
      continue;
    }
    const policyWorker = pickByObjective(models, objective);
    if (!policyWorker) {
      total += Number(e.outcomeScore) || 0;
      n += 1;
      continue;
    }
    if (policyWorker === e.pickedWorker) {
      total += Number(e.outcomeScore) || 0;
    } else {
      const cell = models[policyWorker];
      total +=
        cell?.avgScore != null
          ? Number(cell.avgScore)
          : Math.max(0, (Number(e.outcomeScore) || 0) - 15);
    }
    n += 1;
  }
  if (!n) return computeTrafficEval(banditTable);
  return total / n;
}

function computeTrafficEval(banditTable) {
  let totalN = 0;
  let weighted = 0;
  for (const models of Object.values(banditTable || {})) {
    for (const s of Object.values(models)) {
      const n = Number(s.attempts) || 0;
      const avg = Number(s.avgScore) || 0;
      totalN += n;
      weighted += avg * n;
    }
  }
  if (!totalN) return 50;
  return weighted / totalN;
}
