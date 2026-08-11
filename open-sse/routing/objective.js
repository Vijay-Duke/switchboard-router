/**
 * Objective weighting for Auto routing (LEARNING.md §Objective weighting).
 * Used for:
 *  - post-router tie-break / re-rank candidates
 *  - optimizer policy pick during eval
 *  - cost tier labels in the router pool catalog
 */
import { getPricingForModel } from "../providers/pricing.js";
import {
  DEFAULT_PROVIDER_LATENCY_GUARD_MS,
  providerOf,
} from "./providerPreference.js";

/**
 * Provider preference rank for one model. Lower is preferred; zero disables bias.
 * @param {string} modelStr
 * @param {{ strategy?: string, providerOrder?: string[], providerLatencyMs?: Record<string, number>, providerUsage?: Record<string, number>, providerQuota?: Record<string, number>, guardMs?: number }|null|undefined} bias
 * @returns {number}
 */
export function providerBiasRank(modelStr, bias) {
  try {
    const strategy = bias?.strategy;
    if (!strategy || strategy === "off" || strategy === "round-robin") return 0;
    const provider = providerOf(modelStr);
    const latency = bias.providerLatencyMs?.[provider];
    const guardMs = Number.isFinite(bias.guardMs)
      ? bias.guardMs
      : DEFAULT_PROVIDER_LATENCY_GUARD_MS;
    const guardDemotion = Number.isFinite(latency) && latency > guardMs ? 1e12 : 0;

    if (strategy === "priority") {
      const order = Array.isArray(bias.providerOrder) ? bias.providerOrder : [];
      const index = order.indexOf(provider);
      return (index === -1 ? 1e9 : index) + guardDemotion;
    }
    if (strategy === "fastest") {
      return (Number.isFinite(latency) ? latency : Infinity) + guardDemotion;
    }
    if (strategy === "quota-first") {
      const quota = bias.providerQuota?.[provider];
      const usage = bias.providerUsage?.[provider];
      const rank = Number.isFinite(quota)
        ? 100 - quota
        : 1e6 + (Number.isFinite(usage) ? usage : 0);
      return rank + guardDemotion;
    }
  } catch {
    return 0;
  }
  return 0;
}

function reorderProviderTies(list, providerBias) {
  if (!providerBias || providerBias.strategy === "off") return list;
  const reordered = [];
  let start = 0;
  while (start < list.length) {
    const anchor = list[start].avgScore;
    let end = start + 1;
    while (end < list.length && Math.abs(list[end].avgScore - anchor) <= 15) end += 1;
    const group = list.slice(start, end).map((entry, index) => ({
      entry,
      index,
      rank: providerBiasRank(entry.id, providerBias),
    }));
    group.sort((a, b) => {
      if (a.rank < b.rank) return -1;
      if (a.rank > b.rank) return 1;
      return a.index - b.index;
    });
    reordered.push(...group.map(({ entry }) => entry));
    start = end;
  }
  return reordered;
}

/**
 * Cost tier 0 (cheapest) … 4 (unknown/expensive).
 * Based on blended $/1M input+output when known.
 * @param {string} modelStr - provider/model
 * @returns {number}
 */
export function costTier(modelStr) {
  if (!modelStr) return 4;
  const [provider, ...rest] = modelStr.split("/");
  const model = rest.join("/") || provider;
  const p = getPricingForModel(provider, model);
  if (!p || typeof p.input !== "number") return 4;
  const out = typeof p.output === "number" ? p.output : p.input * 3;
  const blended = p.input + out;
  // Rough tiers matching common model price bands
  if (blended < 2) return 0;
  if (blended < 10) return 1;
  if (blended < 30) return 2;
  if (blended < 80) return 3;
  return 4;
}

/**
 * Estimate the dollar cost of one request from current catalog pricing.
 * @param {string} modelStr - provider/model
 * @param {number} estInputTokens
 * @param {number} avgTokensOut
 * @returns {number|null}
 */
export function estimateRequestCost(modelStr, estInputTokens, avgTokensOut) {
  if (!modelStr) return null;
  const [provider, ...rest] = modelStr.split("/");
  const model = rest.join("/") || provider;
  const p = getPricingForModel(provider, model);
  if (!p || typeof p.input !== "number") return null;
  const out = typeof p.output === "number" ? p.output : p.input * 3;
  return (
    ((Number(estInputTokens) || 0) / 1e6) * p.input +
    ((Number(avgTokensOut) || 0) / 1e6) * out
  );
}

/**
 * Rank workers for a cluster given objective.
 * Higher score is better for sorting (descending).
 *
 * | quality   | highest avgScore |
 * | balanced  | avgScore - 0.001 * costTier, or avgScore - 50 * predicted $ |
 * | economy   | prefer lower cost when avgScore within 10% of best |
 * | latency   | lowest p50LatencyMs (higher rank = lower latency) |
 *
 * @param {Array<{ id: string, avgScore?: number, attempts?: number, p50LatencyMs?: number, avgLatencyMs?: number, avgTokensOut?: number }>} entries
 * @param {string} objective
 * @param {{ estInputTokens?: number, providerBias?: object }} [opts]
 * @returns {Array} sorted best-first
 */
export function rankByObjective(entries, objective = "balanced", opts = {}) {
  const estInputTokens = opts?.estInputTokens;
  const predictedCosts = new Map();
  const list = (entries || []).map((e) => {
    const entry = {
      ...e,
      avgScore: Number(e.avgScore) || 0,
      attempts: Number(e.attempts) || 0,
      p50:
        Number(e.p50LatencyMs) ||
        Number(e.avgLatencyMs) ||
        Number.POSITIVE_INFINITY,
      tier: costTier(e.id),
    };
    predictedCosts.set(
      entry,
      estimateRequestCost(e.id, estInputTokens ?? 0, e.avgTokensOut ?? 500)
    );
    return entry;
  });
  if (!list.length) return list;

  const costKnown =
    Number.isFinite(estInputTokens) &&
    estInputTokens > 0 &&
    list.every((e) => predictedCosts.get(e) != null);
  const obj = objective || "balanced";

  if (obj === "latency") {
    return reorderProviderTies(list.sort((a, b) => {
      if (a.p50 !== b.p50) return a.p50 - b.p50;
      return b.avgScore - a.avgScore;
    }), opts.providerBias);
  }

  if (obj === "quality") {
    return reorderProviderTies(list.sort((a, b) => {
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      return a.tier - b.tier;
    }), opts.providerBias);
  }

  if (obj === "economy") {
    const best = Math.max(...list.map((e) => e.avgScore));
    // Fresh combo / all zeros: pure cost ordering is intentional (no quality signal yet)
    if (!(best > 0)) {
      return reorderProviderTies(list.sort((a, b) => {
        if (costKnown && predictedCosts.get(a) !== predictedCosts.get(b)) {
          return predictedCosts.get(a) - predictedCosts.get(b);
        }
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.avgScore - a.avgScore;
      }), opts.providerBias);
    }
    // Prefer lower cost among those within 10% of best score.
    return reorderProviderTies(list.sort((a, b) => {
      const aClose = a.avgScore >= best * 0.9;
      const bClose = b.avgScore >= best * 0.9;
      if (aClose && bClose) {
        if (costKnown && predictedCosts.get(a) !== predictedCosts.get(b)) {
          return predictedCosts.get(a) - predictedCosts.get(b);
        }
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.avgScore - a.avgScore;
      }
      if (aClose !== bClose) return aClose ? -1 : 1;
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      if (costKnown && predictedCosts.get(a) !== predictedCosts.get(b)) {
        return predictedCosts.get(a) - predictedCosts.get(b);
      }
      return a.tier - b.tier;
    }), opts.providerBias);
  }

  // $0.01 costs 0.5 score points: a light per-request cost tiebreak.
  return reorderProviderTies(list.sort((a, b) => {
    const sa = costKnown
      ? a.avgScore - 50 * predictedCosts.get(a)
      : a.avgScore - 0.001 * a.tier;
    const sb = costKnown
      ? b.avgScore - 50 * predictedCosts.get(b)
      : b.avgScore - 0.001 * b.tier;
    if (sb !== sa) return sb - sa;
    if (costKnown && predictedCosts.get(a) !== predictedCosts.get(b)) {
      return predictedCosts.get(a) - predictedCosts.get(b);
    }
    return a.tier - b.tier;
  }), opts.providerBias);
}

/**
 * Pick best worker id for a cluster under objective, or null.
 * @param {Record<string, { avgScore?: number, attempts?: number, p50LatencyMs?: number, avgLatencyMs?: number, avgTokensOut?: number }>} models
 * @param {string} objective
 * @param {string[]} [poolFilter] - if set, only consider these ids
 * @param {{ estInputTokens?: number }} [opts]
 */
export function pickByObjective(models, objective = "balanced", poolFilter = null, opts = {}) {
  if (!models || typeof models !== "object") return null;
  let entries = Object.entries(models).map(([id, s]) => ({ id, ...s }));
  if (Array.isArray(poolFilter) && poolFilter.length) {
    const allow = new Set(poolFilter);
    entries = entries.filter((e) => allow.has(e.id));
  }
  if (!entries.length) return null;
  const ranked = rankByObjective(entries, objective, opts);
  return ranked[0]?.id || null;
}

/**
 * Split a worker pool into a cheap tier (costTier 0–1) and a frontier tier
 * (costTier 2–4) for Auto v2 tiered routing.
 *
 * - If either half is empty under the 0–1 / 2–4 boundary, fall back to a median
 *   split by tier so both tiers are non-empty when ≥2 distinct tiers exist.
 * - If ALL models share one tier, tier logic is disabled (behave as today):
 *   `disabled: true`, whole pool returned as `cheap`, `frontier` empty.
 *
 * @param {string[]} pool
 * @returns {{ cheap: string[], frontier: string[], disabled: boolean }}
 */
export function splitPoolByTier(pool) {
  const models = (pool || []).filter(Boolean);
  if (models.length <= 1) {
    return { cheap: models.slice(), frontier: [], disabled: true };
  }
  const withTier = models.map((m) => ({ m, t: costTier(m) }));
  const distinct = new Set(withTier.map((x) => x.t));
  if (distinct.size <= 1) {
    return { cheap: models.slice(), frontier: [], disabled: true };
  }

  let cheap = withTier.filter((x) => x.t <= 1).map((x) => x.m);
  let frontier = withTier.filter((x) => x.t >= 2).map((x) => x.m);

  if (!cheap.length || !frontier.length) {
    // Median split: sort by tier (stable on original order), halve by count.
    const sorted = withTier
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i);
    const mid = Math.ceil(sorted.length / 2);
    cheap = sorted.slice(0, mid).map((x) => x.m);
    frontier = sorted.slice(mid).map((x) => x.m);
  }

  return { cheap, frontier, disabled: false };
}

// ── Shrunk posteriors over cluster×worker score ──────────────────────────────
// Point-estimate avgScore discards sample size, which forced the old fixed
// n ≥ 10 / lead > 15 cliff (9 samples said nothing, the 10th flipped the pick)
// and made ε-greedy re-test known-bad arms at frontier prices. Instead each cell
// gets a fractional-count Beta quasi-posterior over score/100, shrunk toward a
// prior pooled across the OTHER clusters for that same worker — most cells here
// have n < 10, so pooling by worker is where the information actually comes from.
//
// ponytail: normal approximation to the Beta interval, not the exact incomplete
// beta — a dependency-free sqrt is accurate enough at κ ≥ 4 total mass. Swap in
// a real quantile if a cell ever needs a tight interval near 0 or 1.

/** Prior mass in pseudo-observations. Small: it must yield to ~10 real events. */
const PRIOR_KAPPA = 4;
/** z for the credible interval (~90%), used for both dominance and separation. */
const PRIOR_Z = 1.645;

/**
 * Prior mean (0–1) for a worker, pooled over every cluster EXCEPT the one being
 * estimated — leave-one-out, so a cell never shrinks toward itself. Falls back to
 * the table-wide mean, then to 0.5 for a worker with no history at all.
 * @param {Record<string, Record<string, object>>|null|undefined} banditTable
 * @param {string} worker
 * @param {string|null} [excludeCluster]
 * @returns {number}
 */
export function workerPriorMean(banditTable, worker, excludeCluster = null) {
  let workerN = 0;
  let workerSum = 0;
  let globalN = 0;
  let globalSum = 0;
  for (const [cluster, models] of Object.entries(banditTable || {})) {
    if (excludeCluster != null && cluster === excludeCluster) continue;
    for (const [id, s] of Object.entries(models || {})) {
      const n = Number(s?.attemptsEff ?? s?.attempts) || 0;
      if (n <= 0) continue;
      const avg = Number(s?.avgScore) || 0;
      globalN += n;
      globalSum += avg * n;
      if (id === worker) {
        workerN += n;
        workerSum += avg * n;
      }
    }
  }
  if (workerN > 0) return workerSum / workerN / 100;
  if (globalN > 0) return globalSum / globalN / 100;
  return 0.5;
}

/**
 * Shrunk posterior for one (cluster, worker) cell, on the 0–100 score scale.
 * A worker absent from the cluster is prior-only — a wide interval, not an
 * absence, so a freshly added model stays a live candidate instead of being
 * invisible to selection.
 *
 * Uses `attemptsEff` (Kish effective sample size) when the optimizer recorded
 * it: avgScore is a WEIGHTED mean (user-rated events count 5×), and treating a
 * single thumbs-up as five independent observations would overstate confidence —
 * doubly so since that rating already moved the score by ±25.
 *
 * @param {Record<string, Record<string, object>>|null|undefined} banditTable
 * @param {string} cluster
 * @param {string} worker
 * @returns {{ mean: number, lo: number, hi: number, sd: number, attempts: number }}
 */
export function posteriorFor(banditTable, cluster, worker) {
  const cell = banditTable?.[cluster]?.[worker];
  const mu0 = workerPriorMean(banditTable, worker, cluster);
  const n = Math.max(0, Number(cell?.attemptsEff ?? cell?.attempts) || 0);
  const y = n > 0 ? Math.min(1, Math.max(0, (Number(cell?.avgScore) || 0) / 100)) : 0;
  const a = PRIOR_KAPPA * mu0 + n * y;
  const b = PRIOR_KAPPA * (1 - mu0) + n * (1 - y);
  const total = a + b;
  const mean = total > 0 ? a / total : mu0;
  const variance = total > 0 ? (a * b) / (total * total * (total + 1)) : 0.25;
  const sd = Math.sqrt(Math.max(0, variance));
  return {
    mean: mean * 100,
    lo: Math.max(0, mean - PRIOR_Z * sd) * 100,
    hi: Math.min(1, mean + PRIOR_Z * sd) * 100,
    sd: sd * 100,
    attempts: Number(cell?.attempts) || 0,
  };
}

/**
 * Candidates that are not provably worse than the best arm: keep w when its
 * upper bound still reaches the highest lower bound. This is the exploration
 * pool — uniform-random exploration over the FULL pool pays frontier price to
 * re-test arms already ruled out, which is the main cost of plain ε-greedy.
 *
 * Conservative by construction (overlapping intervals do not imply an
 * indistinguishable difference), which is the right side to err on for
 * exploration; the fast path below uses the sharper difference test instead.
 *
 * @param {Record<string, Record<string, object>>|null|undefined} banditTable
 * @param {string} cluster
 * @param {string[]} candidates
 * @returns {string[]} never empty when candidates is non-empty
 */
export function nonDominatedSet(banditTable, cluster, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (list.length <= 1) return list.slice();
  const posts = list.map((w) => ({ w, ...posteriorFor(banditTable, cluster, w) }));
  let bestLo = -Infinity;
  for (const p of posts) if (p.lo > bestLo) bestLo = p.lo;
  const kept = posts.filter((p) => p.hi >= bestLo).map((p) => p.w);
  return kept.length ? kept : list.slice();
}

/**
 * Deterministic bandit policy pick for the pre-generation fast path.
 * Returns the winning worker only when the objective winner's posterior
 * SEPARATES from the best other candidate:
 *
 *   z = (mean_w - mean_other) / sqrt(sd_w² + sd_other²)  ≥ PRIOR_Z
 *
 * i.e. the old "leads by > 15 points" becomes "leads by > 15 points of
 * uncertainty". A lone candidate fires unconditionally. Otherwise null and the
 * caller falls through to the cached route / router LLM — so the router still
 * carries cold start, when every posterior is prior-wide and nothing separates.
 *
 * @param {Record<string, Record<string, { avgScore?: number, attempts?: number, attemptsEff?: number }>>|null} banditTable
 * @param {string} cluster
 * @param {string[]} candidates - current worker pool (winner must be in it)
 * @param {string} [objective]
 * @param {{ estInputTokens?: number, providerBias?: object }} [opts]
 * @returns {{ model: string, qualified: number, lead: number }|null}
 */
export function pickBanditPolicy(banditTable, cluster, candidates, objective = "balanced", opts = {}) {
  if (!banditTable || typeof banditTable !== "object" || !cluster) return null;
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return null;
  // Every candidate is scored, including ones with no cell yet (prior-only).
  const posts = new Map(list.map((w) => [w, posteriorFor(banditTable, cluster, w)]));
  // Nothing observed anywhere in this cluster → no signal to act on.
  if (![...posts.values()].some((p) => p.attempts > 0)) return null;

  /** @type {Record<string, object>} */
  const models = {};
  for (const [w, p] of posts) {
    models[w] = { ...(banditTable[cluster]?.[w] || {}), avgScore: p.mean, attempts: p.attempts };
  }
  const winner = pickByObjective(models, objective, null, opts);
  if (!winner) return null;

  if (list.length === 1) {
    return { model: winner, qualified: 1, lead: Infinity };
  }

  const win = posts.get(winner);
  let best = null;
  for (const [w, p] of posts) {
    if (w === winner) continue;
    if (!best || p.mean > best.mean) best = p;
  }
  if (!best) return { model: winner, qualified: 1, lead: Infinity };

  const spread = Math.sqrt(win.sd * win.sd + best.sd * best.sd);
  const lead = win.mean - best.mean;
  if (spread > 0 && lead / spread >= PRIOR_Z) {
    return { model: winner, qualified: list.length, lead };
  }
  return null;
}

/**
 * Human-readable objective instructions for the router system prompt.
 * @param {string} objective
 */
export function objectivePromptText(objective = "balanced") {
  switch (objective) {
    case "quality":
      return "Objective: quality — prefer highest historical win-rate and stronger reasoning models; cost is secondary.";
    case "economy":
      return "Objective: economy — when models are within ~10% quality, prefer lower price/1M tier (cheaper workers).";
    case "latency":
      return "Objective: latency — prefer lowest avg/p50 latency workers when quality is acceptable.";
    case "balanced":
    default:
      return "Objective: balanced — maximize quality with a light preference for lower cost when scores are close.";
  }
}
