/** Blend global model scores into thin local Auto bandit cells without persisting them. */
export const PRIOR_WEIGHT = 5;
export const MIN_LOCAL = 10;
export const CLUSTER_PRIOR_MIN_N = 5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Apply a small global-score prior to immature cluster × worker cells.
 * This is intentionally ephemeral: callers must never persist the result.
 */
export function blendWarmStart(banditTable, globalStats, opts = {}) {
  void opts;
  try {
    if (!banditTable || typeof banditTable !== "object") return banditTable;
    if (!Array.isArray(globalStats) || !globalStats.length) return banditTable;

    const globalByWorker = new Map();
    for (const entry of globalStats) {
      if (entry?.worker) globalByWorker.set(entry.worker, entry);
    }

    const result = Object.create(null);
    for (const [cluster, workers] of Object.entries(banditTable)) {
      const copiedWorkers = Object.create(null);
      for (const [worker, cell] of Object.entries(workers || {})) {
        const localN = Number(cell?.attempts) || 0;
        if (localN >= MIN_LOCAL) {
          copiedWorkers[worker] = cell;
          continue;
        }

        const global = globalByWorker.get(worker);
        if (!global) {
          copiedWorkers[worker] = cell;
          continue;
        }

        const clusterPrior = global.clusters?.[cluster];
        const priorAvg =
          clusterPrior && Number(clusterPrior.n) >= CLUSTER_PRIOR_MIN_N
            ? Number(clusterPrior.avgScore)
            : Number(global.avgScore);
        if (!Number.isFinite(priorAvg)) {
          copiedWorkers[worker] = cell;
          continue;
        }

        const localSum = (Number(cell?.avgScore) || 0) * localN;
        const effectiveAverage =
          (priorAvg * PRIOR_WEIGHT + localSum) / (PRIOR_WEIGHT + localN);
        copiedWorkers[worker] = {
          ...(cell || {}),
          avgScore: clamp(effectiveAverage, 0, 100),
        };
      }
      result[cluster] = copiedWorkers;
    }
    return result;
  } catch {
    return banditTable;
  }
}
