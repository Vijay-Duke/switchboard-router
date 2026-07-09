/**
 * Outcome score 0–100 (docs/switchboard/SPEC.md §8, LEARNING.md).
 *
 * Spec pseudocode (authoritative):
 *   +40  worker 2xx AND no fallback
 *   +20  high confidence + success (score already > 0 from base)
 *   +15  latency below cluster p50
 *   -30  fallback/retry used
 *   -20  worker 4xx/5xx
 *   +10  non-empty completion (tokensOut > 0 or hasCompletion)
 *   ±25  user feedback (v1.1)
 *
 * @param {{
 *   workerOk: boolean,
 *   confidence?: string,
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
  confidence = "low",
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

  // +20 high confidence only when we already have positive base (success path)
  if (workerOk && confidence === "high" && score > 0) score += 20;

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

  // ±25 user feedback (v1.1)
  if (userRating === 1) score += 25;
  if (userRating === -1) score -= 25;

  return Math.max(0, Math.min(100, score));
}
