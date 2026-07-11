/**
 * Auto v2 feedback + judge persistence tests: the routingRepo outcome-adjustment
 * methods and the judge context's runJudge dispatch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createJudgeContext,
  resetJudgeState,
  takeJudgeEscalation,
} from "../../open-sse/routing/judge.js";

// ── In-memory routing_events store behind a mocked DB adapter ──────────────────
const store = { rows: [] };
const db = {
  all: (sql, params) => {
    if (sql.includes("WHERE requestId = ?")) {
      return store.rows.filter((r) => r.requestId === params[0]).map((r) => ({ ...r }));
    }
    return [];
  },
  get: () => null,
  run: (sql, params) => {
    if (sql.includes("UPDATE routing_events SET outcomeScore")) {
      const [outcomeScore, meta, id] = params;
      const row = store.rows.find((r) => r.id === id);
      if (row) {
        row.outcomeScore = outcomeScore;
        row.meta = meta;
      }
    }
  },
  transaction: (fn) => fn(),
};

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => db),
}));

const { setUserRatingByRequestId, applyJudgeScoreByRequestId } = await import(
  "../../src/lib/db/repos/routingRepo.js"
);

function seedTerminalEvent(requestId, base = 50) {
  const scoreInputs = {
    workerOk: true,
    workerLatencyMs: 100,
    clusterP50LatencyMs: null,
    fallbackUsed: false,
    retries: 0,
    hasCompletion: true,
    tokensOut: 20,
  };
  store.rows = [
    {
      id: 1,
      requestId,
      comboName: "c",
      outcomeScore: base,
      meta: JSON.stringify({ terminal: true, scoreInputs, baseOutcomeScore: base }),
    },
  ];
}

describe("setUserRatingByRequestId", () => {
  beforeEach(() => seedTerminalEvent("req-1"));

  it("sets a positive rating and recomputes the score", async () => {
    const r = await setUserRatingByRequestId("req-1", 1);
    expect(r.updated).toBe(1);
    expect(store.rows[0].outcomeScore).toBe(75);
    expect(JSON.parse(store.rows[0].meta).userRating).toBe(1);
  });

  it("clears a rating back to base when passed 0", async () => {
    await setUserRatingByRequestId("req-1", -1);
    expect(store.rows[0].outcomeScore).toBe(25);
    await setUserRatingByRequestId("req-1", 0);
    expect(store.rows[0].outcomeScore).toBe(50);
    expect(JSON.parse(store.rows[0].meta).userRating).toBe(null);
  });

  it("returns updated:0 for an unknown requestId (→ 404 at the route)", async () => {
    const r = await setUserRatingByRequestId("nope", 1);
    expect(r.updated).toBe(0);
  });

  it("a user rating overrides a prior judge adjustment", async () => {
    await applyJudgeScoreByRequestId("req-1", 9); // judge +25 → 75
    expect(store.rows[0].outcomeScore).toBe(75);
    await setUserRatingByRequestId("req-1", -1); // user override → 25
    expect(store.rows[0].outcomeScore).toBe(25);
    expect(JSON.parse(store.rows[0].meta).scoreAdjustedBy).toBe("user");
  });
});

describe("applyJudgeScoreByRequestId", () => {
  beforeEach(() => seedTerminalEvent("req-2"));
  it("folds a judge score into the terminal event", async () => {
    const r = await applyJudgeScoreByRequestId("req-2", 2); // ≤3 → −25
    expect(r.updated).toBe(1);
    expect(store.rows[0].outcomeScore).toBe(25);
    expect(JSON.parse(store.rows[0].meta).judgeAdjusted).toBe(true);
  });
});

// ── Judge context dispatch ────────────────────────────────────────────────────
describe("createJudgeContext.runJudge", () => {
  beforeEach(() => resetJudgeState());

  function makeCtx({ judgeText, applyJudgeScore, dailyCap = 200 }) {
    return createJudgeContext({
      tuning: { judgeSampleRate: 0.07, judgeDailyCap: dailyCap },
      routerModel: "router/x",
      comboName: "c",
      handleSingleModel: async () => ({ _t: judgeText }),
      extractAssistantText: async (r) => ({ text: r._t }),
      applyJudgeScore,
      log: { info: () => {}, warn: () => {} },
    });
  }
  const baseEvent = {
    requestId: "r1",
    pick: { cluster: "debug" },
    signals: { userSummary: "fix the bug" },
  };

  it("applies a confident non-neutral score", async () => {
    const apply = vi.fn(async () => {});
    const ctx = makeCtx({ judgeText: '{"score":9,"confident":true}', applyJudgeScore: apply });
    await ctx.runJudge({ baseEvent, assistantText: "the answer" });
    expect(apply).toHaveBeenCalledWith("r1", 9);
  });

  it("does not adjust for a neutral score", async () => {
    const apply = vi.fn(async () => {});
    const ctx = makeCtx({ judgeText: '{"score":6,"confident":true}', applyJudgeScore: apply });
    await ctx.runJudge({ baseEvent, assistantText: "the answer" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops an unconfident verdict", async () => {
    const apply = vi.fn(async () => {});
    const ctx = makeCtx({ judgeText: '{"score":9,"confident":false}', applyJudgeScore: apply });
    await ctx.runJudge({ baseEvent, assistantText: "the answer" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("records a flag for a low score that later triggers escalation", async () => {
    const ctx = makeCtx({ judgeText: '{"score":2,"confident":true}', applyJudgeScore: async () => {} });
    await ctx.runJudge({ baseEvent, assistantText: "bad answer" });
    // quality threshold = 1 flag
    expect(takeJudgeEscalation("c", "debug", "quality")).toBe(true);
  });

  it("retries once when the terminal event insert has not committed yet", async () => {
    // First call races the fire-and-forget insert (0 rows); retry lands after it commits.
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ updated: 0 })
      .mockResolvedValueOnce({ updated: 1 });
    const ctx = makeCtx({ judgeText: '{"score":9,"confident":true}', applyJudgeScore: apply });
    await ctx.runJudge({ baseEvent, assistantText: "the answer" });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(2, "r1", 9);
  });

  it("fails closed when the daily budget is exhausted", async () => {
    const apply = vi.fn(async () => {});
    let called = 0;
    const ctx = createJudgeContext({
      tuning: { judgeSampleRate: 0.07, judgeDailyCap: 1 },
      routerModel: "router/x",
      comboName: "c",
      handleSingleModel: async () => {
        called += 1;
        return { _t: '{"score":9,"confident":true}' };
      },
      extractAssistantText: async (r) => ({ text: r._t }),
      applyJudgeScore: apply,
      log: { info: () => {}, warn: () => {} },
    });
    await ctx.runJudge({ baseEvent, assistantText: "a" }); // consumes the 1 unit
    await ctx.runJudge({ baseEvent, assistantText: "a" }); // budget gone → skipped
    expect(called).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("is null when sampling is disabled", () => {
    const ctx = createJudgeContext({
      tuning: { judgeSampleRate: 0 },
      routerModel: "router/x",
      comboName: "c",
      handleSingleModel: async () => ({}),
      extractAssistantText: async () => ({ text: "" }),
    });
    expect(ctx).toBe(null);
  });
});
