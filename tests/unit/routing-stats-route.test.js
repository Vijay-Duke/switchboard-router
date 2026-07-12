import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGlobalModelStats: vi.fn(() => []),
  getComboScoreTimeline: vi.fn(() => []),
  getPickSourceCounts: vi.fn(() => ({ total: 0 })),
  getClusterWorkerStats: vi.fn(() => []),
  getJudgeCoverage: vi.fn(() => ({ total: 0 })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/lib/jsonError.js", () => ({
  jsonError: (status, message) => new Response(JSON.stringify({ error: message }), { status }),
  safeErrorMessage: (error, fallback) => error?.message || fallback,
}));

vi.mock("@/lib/db/repos/routingRepo.js", () => ({
  getGlobalModelStats: mocks.getGlobalModelStats,
  getComboScoreTimeline: mocks.getComboScoreTimeline,
  getPickSourceCounts: mocks.getPickSourceCounts,
  getClusterWorkerStats: mocks.getClusterWorkerStats,
  getJudgeCoverage: mocks.getJudgeCoverage,
}));

vi.mock("open-sse/routing/routingCache.js", () => ({
  cached: async (_key, loader) => loader(),
}));

const { GET } = await import("../../src/app/api/routing/stats/route.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("routing stats route", () => {
  it("returns global stats without combo-specific data when no combo is provided", async () => {
    const response = await GET(new Request("http://localhost/api/routing/stats?days=14"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.combo).toBeNull();
    expect(body.timeline).toEqual([]);
    expect(body.pickSource).toBeNull();
    expect(mocks.getGlobalModelStats).toHaveBeenCalledWith(14);
    expect(mocks.getComboScoreTimeline).not.toHaveBeenCalled();
  });

  it("loads combo-specific stats when a combo is provided", async () => {
    const response = await GET(new Request("http://localhost/api/routing/stats?combo=x&days=7"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.combo).toBe("x");
    expect(mocks.getComboScoreTimeline).toHaveBeenCalledWith("x", 7);
    expect(mocks.getPickSourceCounts).toHaveBeenCalledWith("x", 7);
    expect(mocks.getClusterWorkerStats).toHaveBeenCalledWith("x", 7);
    expect(mocks.getJudgeCoverage).toHaveBeenCalledWith("x", 7);
  });

  it.each([
    ["999", 90],
    ["abc", 14],
    // "0" is falsy, so Number("0")||14 defaults to 14 (matches the insights route convention).
    ["0", 14],
  ])("clamps days=%s to %i", async (days, expectedDays) => {
    const response = await GET(new Request(`http://localhost/api/routing/stats?combo=x&days=${days}`));

    expect(response.status).toBe(200);
    expect(mocks.getGlobalModelStats).toHaveBeenCalledWith(expectedDays);
    expect(mocks.getComboScoreTimeline).toHaveBeenCalledWith("x", expectedDays);
    expect(mocks.getPickSourceCounts).toHaveBeenCalledWith("x", expectedDays);
    expect(mocks.getClusterWorkerStats).toHaveBeenCalledWith("x", expectedDays);
    expect(mocks.getJudgeCoverage).toHaveBeenCalledWith("x", expectedDays);
  });
});
