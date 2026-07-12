import { beforeEach, describe, expect, it } from "vitest";
import {
  HALF_LIFE_MS,
  applyRatingOverlay,
  decayedCellOverlay,
  overlayedBanditTable,
  resetOverlay,
} from "../../open-sse/routing/overlay.js";

const combo = "overlay-combo";
const cluster = "debug";
const worker = "openai/model";

function table(avgScore = 50) {
  return {
    [cluster]: {
      [worker]: {
        attempts: 12,
        wins: 8,
        avgScore,
        avgLatencyMs: 100,
        p50LatencyMs: 90,
      },
    },
  };
}

describe("rating bandit overlay", () => {
  beforeEach(() => resetOverlay());

  it("applies positive and negative ratings while ignoring neutral ratings", () => {
    const base = table();
    applyRatingOverlay(combo, cluster, worker, 1);
    expect(overlayedBanditTable(base, combo)[cluster][worker].avgScore).toBe(65);

    resetOverlay();
    applyRatingOverlay(combo, cluster, worker, -1);
    expect(overlayedBanditTable(base, combo)[cluster][worker].avgScore).toBe(35);

    resetOverlay();
    applyRatingOverlay(combo, cluster, worker, 0);
    expect(overlayedBanditTable(base, combo)).toBe(base);
  });

  it("caps multiple ratings in one cell", () => {
    const base = table();
    applyRatingOverlay(combo, cluster, worker, 1);
    applyRatingOverlay(combo, cluster, worker, 1);
    expect(overlayedBanditTable(base, combo)[cluster][worker].avgScore).toBe(65);
  });

  it("halves an entry after one half-life", () => {
    const now = 2_000_000_000_000;
    expect(decayedCellOverlay([{ delta: 25, ts: now - HALF_LIFE_MS }], now)).toBeCloseTo(12.5);
  });

  it("returns the original table on the no-overlay fast path", () => {
    const base = table();
    expect(overlayedBanditTable(base, combo)).toBe(base);
  });

  it("does not mutate the cached input table", () => {
    const base = table();
    applyRatingOverlay(combo, cluster, worker, 1);
    const result = overlayedBanditTable(base, combo);
    expect(result).not.toBe(base);
    expect(result[cluster][worker]).not.toBe(base[cluster][worker]);
    expect(base[cluster][worker].avgScore).toBe(50);
    expect(result[cluster][worker]).toMatchObject({
      attempts: 12,
      wins: 8,
      avgLatencyMs: 100,
      p50LatencyMs: 90,
      avgScore: 65,
    });
  });
});
