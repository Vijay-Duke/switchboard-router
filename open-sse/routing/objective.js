/**
 * Objective weighting for Auto routing (LEARNING.md §Objective weighting).
 * Used for:
 *  - post-router tie-break / re-rank candidates
 *  - optimizer policy pick during eval
 *  - cost tier labels in the router pool catalog
 */
import { getPricingForModel } from "../providers/pricing.js";

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
 * Rank workers for a cluster given objective.
 * Higher score is better for sorting (descending).
 *
 * | quality   | highest avgScore |
 * | balanced  | avgScore - 0.001 * costTier |
 * | economy   | prefer lower cost when avgScore within 10% of best |
 * | latency   | lowest p50LatencyMs (higher rank = lower latency) |
 *
 * @param {Array<{ id: string, avgScore?: number, attempts?: number, p50LatencyMs?: number, avgLatencyMs?: number }>} entries
 * @param {string} objective
 * @returns {Array} sorted best-first
 */
export function rankByObjective(entries, objective = "balanced") {
  const list = (entries || []).map((e) => ({
    ...e,
    avgScore: Number(e.avgScore) || 0,
    attempts: Number(e.attempts) || 0,
    p50:
      Number(e.p50LatencyMs) ||
      Number(e.avgLatencyMs) ||
      Number.POSITIVE_INFINITY,
    tier: costTier(e.id),
  }));
  if (!list.length) return list;

  const obj = objective || "balanced";

  if (obj === "latency") {
    return list.sort((a, b) => {
      if (a.p50 !== b.p50) return a.p50 - b.p50;
      return b.avgScore - a.avgScore;
    });
  }

  if (obj === "quality") {
    return list.sort((a, b) => {
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      return a.tier - b.tier;
    });
  }

  if (obj === "economy") {
    const best = Math.max(...list.map((e) => e.avgScore));
    // Fresh combo / all zeros: pure cost ordering is intentional (no quality signal yet)
    if (!(best > 0)) {
      return list.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.avgScore - a.avgScore;
      });
    }
    // Prefer lower cost among those within 10% of best score
    return list.sort((a, b) => {
      const aClose = a.avgScore >= best * 0.9;
      const bClose = b.avgScore >= best * 0.9;
      if (aClose && bClose) {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.avgScore - a.avgScore;
      }
      if (aClose !== bClose) return aClose ? -1 : 1;
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      return a.tier - b.tier;
    });
  }

  // balanced: avgScore - 0.001 * costTier
  return list.sort((a, b) => {
    const sa = a.avgScore - 0.001 * a.tier;
    const sb = b.avgScore - 0.001 * b.tier;
    if (sb !== sa) return sb - sa;
    return a.tier - b.tier;
  });
}

/**
 * Pick best worker id for a cluster under objective, or null.
 * @param {Record<string, { avgScore?: number, attempts?: number, p50LatencyMs?: number, avgLatencyMs?: number }>} models
 * @param {string} objective
 * @param {string[]} [poolFilter] - if set, only consider these ids
 */
export function pickByObjective(models, objective = "balanced", poolFilter = null) {
  if (!models || typeof models !== "object") return null;
  let entries = Object.entries(models).map(([id, s]) => ({ id, ...s }));
  if (Array.isArray(poolFilter) && poolFilter.length) {
    const allow = new Set(poolFilter);
    entries = entries.filter((e) => allow.has(e.id));
  }
  if (!entries.length) return null;
  const ranked = rankByObjective(entries, objective);
  return ranked[0]?.id || null;
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
