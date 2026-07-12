/**
 * Ephemeral user-rating adjustments for the promoted Auto bandit table.
 * Never persisted: a learning-version write resets the affected combo overlay.
 */
const g = (global.__banditOverlay ??= { byCombo: Object.create(null) });

export const HALF_LIFE_MS = 24 * 60 * 60 * 1000;
export const CELL_CLAMP = 15;
export const PRUNE_BELOW = 0.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Clear one combo's ephemeral adjustments, or all adjustments when omitted. */
export function resetOverlay(comboName) {
  try {
    if (comboName) {
      delete g.byCombo[comboName];
      return;
    }
    g.byCombo = Object.create(null);
  } catch {
    /* fail-open */
  }
}

/** Test-friendly alias for a complete overlay reset. */
export function resetOverlayState() {
  resetOverlay();
}

/** Add a decaying rating adjustment to one existing-or-future bandit cell. */
export function applyRatingOverlay(comboName, cluster, worker, rating) {
  try {
    if (!comboName || !cluster || !worker) return;
    const delta = Number(rating) * 25;
    if (!Number.isFinite(delta) || !delta) return;
    const byCombo = (g.byCombo ??= Object.create(null));
    const byCluster = (byCombo[comboName] ??= Object.create(null));
    const entries = (byCluster[cluster] ??= Object.create(null));
    (entries[worker] ??= []).push({ delta, ts: Date.now() });
  } catch {
    /* fail-open */
  }
}

/** Return the bounded, exponentially decayed adjustment for one overlay cell. */
export function decayedCellOverlay(entries, now = Date.now()) {
  try {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const at = Number(now);
    if (!Number.isFinite(at)) return 0;
    let total = 0;
    for (const entry of entries) {
      const delta = Number(entry?.delta);
      const ts = Number(entry?.ts);
      if (!Number.isFinite(delta) || !Number.isFinite(ts)) continue;
      total += delta * 0.5 ** ((at - ts) / HALF_LIFE_MS);
    }
    return Number.isFinite(total) ? clamp(total, -CELL_CLAMP, CELL_CLAMP) : 0;
  } catch {
    return 0;
  }
}

/**
 * Apply the live overlay to a copied bandit table. No-overlay calls retain the
 * original reference; overlay-only cells are ignored because no base cell exists.
 */
export function overlayedBanditTable(banditTable, comboName, now = Date.now()) {
  try {
    const combo = comboName && g.byCombo?.[comboName];
    if (!combo || !Object.keys(combo).length) return banditTable;

    for (const [cluster, workers] of Object.entries(combo)) {
      for (const [worker, entries] of Object.entries(workers || {})) {
        const kept = Array.isArray(entries)
          ? entries.filter(
              (entry) => Math.abs(decayedCellOverlay([entry], now)) >= PRUNE_BELOW
            )
          : [];
        if (kept.length) workers[worker] = kept;
        else delete workers[worker];
      }
      if (!Object.keys(workers).length) delete combo[cluster];
    }
    if (!Object.keys(combo).length) {
      delete g.byCombo[comboName];
      return banditTable;
    }

    const table = banditTable && typeof banditTable === "object" ? banditTable : {};
    const result = Object.create(null);
    for (const [cluster, workers] of Object.entries(table)) {
      const copiedWorkers = Object.create(null);
      const overlays = combo[cluster];
      for (const [worker, cell] of Object.entries(workers || {})) {
        const entries = overlays?.[worker];
        const baseAvg = Number(cell?.avgScore) || 0;
        copiedWorkers[worker] = {
          ...(cell || {}),
          avgScore: clamp(baseAvg + decayedCellOverlay(entries, now), 0, 100),
        };
      }
      if (overlays && !Object.keys(overlays).length) delete combo[cluster];
      result[cluster] = copiedWorkers;
    }
    if (!Object.keys(combo).length) delete g.byCombo[comboName];
    return result;
  } catch {
    return banditTable;
  }
}
