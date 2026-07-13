import { beforeEach, describe, expect, it } from "vitest";
import {
  getVaultStats,
  recordVaultHit,
  recordVaultStore,
  resetVaultStats,
} from "open-sse/rtk/vaultStats.js";

beforeEach(() => {
  resetVaultStats();
});

describe("RTK vault stats", () => {
  it("starts empty", () => {
    expect(getVaultStats()).toEqual({ entries: 0, hits: 0, bytesSaved: 0 });
  });

  it("records stored entries and saved bytes", () => {
    recordVaultStore(2, 5000);
    recordVaultStore(1, 1000);

    expect(getVaultStats()).toEqual({ entries: 3, hits: 0, bytesSaved: 6000 });
  });

  it("records vault search hits", () => {
    recordVaultHit();
    recordVaultHit();
    recordVaultHit(3);

    expect(getVaultStats()).toEqual({ entries: 0, hits: 5, bytesSaved: 0 });
  });

  it("coerces invalid values to zero", () => {
    recordVaultStore(2, 5000);
    recordVaultHit(3);
    recordVaultStore(NaN, -10);
    recordVaultHit(Infinity);

    expect(getVaultStats()).toEqual({ entries: 2, hits: 3, bytesSaved: 5000 });
  });

  it("returns a copy of the counters", () => {
    const stats = getVaultStats();
    stats.entries = 100;
    stats.hits = 100;
    stats.bytesSaved = 100;

    expect(getVaultStats()).toEqual({ entries: 0, hits: 0, bytesSaved: 0 });
  });
});
