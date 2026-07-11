/**
 * Outcome score 0–100 (docs/switchboard/SPEC.md §8, LEARNING.md).
 *
 * Confidence-neutral: the score is a function of the worker's actual
 * performance only (success, latency, completion, fallback, user rating).
 * Router confidence is NOT a term — it is forced to "low" on exploration
 * picks, so scoring it would structurally bias bandit avgScore comparisons
 * against exploration and prevent the bandit from ever discovering a better
 * arm. Confidence still lives in event meta/telemetry for observability.
 *
 * Spec pseudocode (authoritative):
 *   +40  worker 2xx AND no fallback
 *   +15  latency below cluster p50
 *   -30  fallback/retry used
 *   -20  worker 4xx/5xx
 *   +10  non-empty completion (tokensOut > 0 or hasCompletion)
 *   ±25  user feedback (v1.1)
 *
 * @param {{
 *   workerOk: boolean,
 *   workerLatencyMs?: number|null,
 *   clusterP50LatencyMs?: number|null,
 *   fallbackUsed?: boolean,
 *   retries?: number,
 *   hasCompletion?: boolean,
 *   tokensOut?: number|null,
 *   userRating?: number|null,
 * }} args
 */
export function computeOutcomeScore({
  workerOk,
  workerLatencyMs = null,
  clusterP50LatencyMs = null,
  fallbackUsed = false,
  retries = 0,
  hasCompletion = false,
  tokensOut = null,
  userRating = null,
}) {
  let score = 0;
  const usedFallback = !!(fallbackUsed || (retries != null && retries > 0));

  // +40 only on clean 2xx with no fallback (SPEC §8)
  if (workerOk && !usedFallback) score += 40;
  // -20 on worker failure
  if (!workerOk) score -= 20;

  // +15 latency below cluster p50
  if (
    workerOk &&
    typeof workerLatencyMs === "number" &&
    typeof clusterP50LatencyMs === "number" &&
    clusterP50LatencyMs > 0 &&
    workerLatencyMs < clusterP50LatencyMs
  ) {
    score += 15;
  }

  // -30 fallback/retry
  if (usedFallback) score -= 30;

  // +10 non-empty completion (never synonym of workerOk alone)
  const completed =
    hasCompletion === true ||
    (typeof tokensOut === "number" && tokensOut > 0);
  if (workerOk && completed) score += 10;

  // ±25 user feedback (v1.1) — also the slot the sampled LLM-judge feeds through.
  if (userRating === 1) score += 25;
  if (userRating === -1) score -= 25;

  return Math.max(0, Math.min(100, score));
}

/**
 * Map an LLM-judge quality score (0–10) to the ±25 rating slot.
 * ≥8 → +1 (+25), ≤3 → −1 (−25), 4–7 → 0 (no adjustment).
 * @param {number|null|undefined} score
 * @returns {number} 1 | -1 | 0
 */
export function judgeScoreToRating(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  if (s >= 8) return 1;
  if (s <= 3) return -1;
  return 0;
}

/**
 * Recompute a stored event's outcomeScore after a user rating and/or judge score.
 * Pure: takes the event meta + stored score, returns the new score and next meta.
 *
 * Precedence: an explicit user rating (±1) OVERRIDES a judge adjustment on the
 * same event; user rating 0 clears the user override (judge, if any, re-applies).
 * Recompute is exact when meta.scoreInputs was persisted (all new v2 events);
 * legacy events without it fall back to a best-effort delta off the stored score.
 *
 * @param {object} meta - parsed event meta (may contain scoreInputs, userRating, judgeScore)
 * @param {number|null} storedScore - current outcomeScore column
 * @param {{ userRating?: number, judgeScore?: number }} update - fields to apply (undefined = leave as-is)
 * @returns {{ outcomeScore: number, meta: object, changed: boolean }}
 */
export function recomputeStoredOutcome(meta, storedScore, update = {}) {
  const m = meta && typeof meta === "object" ? { ...meta } : {};

  const nextUserRating =
    update.userRating !== undefined
      ? update.userRating === 0
        ? null
        : update.userRating
      : m.userRating ?? null;
  const nextJudgeScore =
    update.judgeScore !== undefined ? update.judgeScore : m.judgeScore ?? null;

  const judgeRating = nextJudgeScore != null ? judgeScoreToRating(nextJudgeScore) : 0;
  // User override wins; otherwise the judge's non-neutral rating applies.
  const effective =
    nextUserRating === 1 || nextUserRating === -1 ? nextUserRating : judgeRating || null;

  const si = m.scoreInputs;
  let outcomeScore;
  if (si && typeof si === "object") {
    outcomeScore = computeOutcomeScore({ ...si, userRating: effective });
  } else {
    // Legacy anchor: base = pre-adjustment score if known, else the stored value.
    const base =
      typeof m.baseOutcomeScore === "number" ? m.baseOutcomeScore : Number(storedScore) || 0;
    const delta = (effective || 0) * 25;
    outcomeScore = Math.max(0, Math.min(100, base + delta));
  }

  m.userRating = nextUserRating;
  if (nextJudgeScore != null) m.judgeScore = nextJudgeScore;
  m.scoreAdjustedBy =
    nextUserRating === 1 || nextUserRating === -1
      ? "user"
      : judgeRating
        ? "judge"
        : null;
  m.judgeAdjusted = !!judgeRating && !(nextUserRating === 1 || nextUserRating === -1);

  const changed = Number(storedScore) !== outcomeScore;
  return { outcomeScore, meta: m, changed };
}
