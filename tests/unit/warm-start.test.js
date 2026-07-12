import { describe, expect, it } from "vitest";
import {
  blendWarmStart,
  CLUSTER_PRIOR_MIN_N,
  MIN_LOCAL,
  PRIOR_WEIGHT,
} from "../../open-sse/routing/warmStart.js";

const globalStats = [
  {
    worker: "provider/model-a",
    n: 20,
    avgScore: 60,
    winRate: 0.5,
    avgLatencyMs: 200,
    clusters: { code: { n: 5, avgScore: 40 } },
  },
];

describe("blendWarmStart", () => {
  it("blends a thin cell with its cluster prior", () => {
    const table = { code: { "provider/model-a": { attempts: 2, avgScore: 90 } } };

    const result = blendWarmStart(table, globalStats);

    expect(result.code["provider/model-a"].avgScore).toBeCloseTo(380 / 7, 1);
    expect(PRIOR_WEIGHT).toBe(5);
  });

  it("leaves mature cells unchanged", () => {
    const table = {
      code: { "provider/model-a": { attempts: MIN_LOCAL, avgScore: 90, wins: 9 } },
    };

    const result = blendWarmStart(table, globalStats);

    expect(result.code["provider/model-a"]).toBe(table.code["provider/model-a"]);
  });

  it("leaves cells without a global worker entry unchanged", () => {
    const table = { code: { "provider/unknown": { attempts: 2, avgScore: 90 } } };

    const result = blendWarmStart(table, globalStats);

    expect(result.code["provider/unknown"]).toBe(table.code["provider/unknown"]);
  });

  it("falls back to the worker overall average for undersized cluster priors", () => {
    const table = { code: { "provider/model-a": { attempts: 0, avgScore: 90 } } };
    const sparseClusterStats = [{
      ...globalStats[0],
      avgScore: 70,
      clusters: { code: { n: CLUSTER_PRIOR_MIN_N - 1, avgScore: 40 } },
    }];

    const result = blendWarmStart(table, sparseClusterStats);

    expect(result.code["provider/model-a"].avgScore).toBe(70);
  });

  it("does not mutate the input table", () => {
    const table = { code: { "provider/model-a": { attempts: 2, avgScore: 90 } } };

    blendWarmStart(table, globalStats);

    expect(table.code["provider/model-a"].avgScore).toBe(90);
  });

  it("returns the original table when no global priors exist", () => {
    const table = { code: { "provider/model-a": { attempts: 2, avgScore: 90 } } };

    expect(blendWarmStart(table, [])).toBe(table);
  });
});
