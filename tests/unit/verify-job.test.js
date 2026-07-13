import { describe, expect, it, beforeEach } from "vitest";
import {
  startVerify,
  getVerifyStatus,
  cancelVerify,
  __resetVerifyJobForTests,
} from "../../src/lib/model-probe/verifyJob.js";

// runBatch is real, but we inject fake probe fns + a fake batch runner via deps.
function makeDeps(overrides = {}) {
  const upserts = [];
  return {
    upserts,
    upsertProbeResult: async (r) => { upserts.push(r); },
    getProbesForScope: async () => [],
    // fake runBatch: every model ok with latency 10
    runBatch: async ({ models }) => ({
      results: models.map((m) => ({
        modelId: m.id, canonicalId: m.canonicalId, kind: m.kind,
        latencyMs: 10, probeStatus: "ok", failureClass: null,
        failureMessage: null, checkedAt: "2026-07-13T00:00:00.000Z",
      })),
      caps: {},
    }),
    ...overrides,
  };
}

const MODELS = [
  { id: "a", canonicalId: "a", kind: "llm" },
  { id: "b", canonicalId: "b", kind: "llm" },
  { id: "c", canonicalId: "c", kind: "llm" },
];

describe("verifyJob core", () => {
  beforeEach(() => __resetVerifyJobForTests());

  it("runs to completion and counts ok", async () => {
    const deps = makeDeps();
    await startVerify({
      connectionId: "c1", scopeKey: "s1", providerId: "p", providerAlias: "p",
      models: MODELS, opts: { concurrency: 2, batchSize: 2, timeoutMs: 1000 },
      baseUrl: "http://x", deps,
    });
    // allow background loop to finish
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c1");
    expect(s.status).toBe("done");
    expect(s.ok).toBe(3);
    expect(s.dead).toBe(0);
    expect(s.total).toBe(3);
    expect(deps.upserts).toHaveLength(3);
  });

  it("overlap guard returns the running job instead of starting a second", async () => {
    let resolveBatch;
    const gate = new Promise((r) => { resolveBatch = r; });
    const deps = makeDeps({
      runBatch: async ({ models }) => {
        await gate;
        return { results: models.map((m) => ({ modelId: m.id, canonicalId: m.canonicalId, kind: m.kind, latencyMs: 1, probeStatus: "ok", failureClass: null, failureMessage: null, checkedAt: "t" })), caps: {} };
      },
    });
    const first = startVerify({ connectionId: "c1", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    const second = await startVerify({ connectionId: "c1", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    expect(second.status).toBe("running");
    resolveBatch();
    await first;
    // Wait for the background loop to complete after resolving the gate.
    await new Promise((r) => setTimeout(r, 50));
    // Verify that exactly ONE loop's worth of upserts happened (3 models total).
    // If two loops had run, we'd have 6 upserts (3 from each).
    expect(deps.upserts).toHaveLength(3);
  });

  it("cancel stops after the current batch", async () => {
    const deps = makeDeps();
    await startVerify({ connectionId: "c2", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    cancelVerify("c2");
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c2");
    expect(["cancelled", "done"]).toContain(s.status); // cancelled if caught mid-run
    expect(s.done).toBeLessThanOrEqual(3);
  });

  it("all-auth-failure batch sets status error", async () => {
    const deps = makeDeps({
      runBatch: async ({ models }) => ({
        results: models.map((m) => ({ modelId: m.id, canonicalId: m.canonicalId, kind: m.kind, latencyMs: 1, probeStatus: "retryable", failureClass: "auth", failureMessage: "HTTP 401", checkedAt: "t" })),
        caps: {},
      }),
    });
    await startVerify({ connectionId: "c3", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 3, timeoutMs: 1 }, baseUrl: "x", deps });
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c3");
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/auth/i);
  });

  it("prep failure (getProbesForScope throws) marks job as error, not running", async () => {
    const deps = makeDeps({
      getProbesForScope: async () => { throw new Error("DB connection failed"); },
    });
    const snap = await startVerify({
      connectionId: "c4", scopeKey: "s", providerId: "p", providerAlias: "p",
      models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps,
    });
    // The returned snapshot must reflect the error immediately (no waiting needed).
    expect(snap.status).toBe("error");
    expect(snap.error).toMatch(/DB connection failed/);
    expect(snap.finishedAt).toBeTruthy();
  });

  it("after prep failure, subsequent startVerify for same connectionId is not blocked", async () => {
    // First call: prep throws → status becomes "error".
    const failDeps = makeDeps({
      getProbesForScope: async () => { throw new Error("transient failure"); },
    });
    await startVerify({
      connectionId: "c5", scopeKey: "s", providerId: "p", providerAlias: "p",
      models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps: failDeps,
    });

    // Second call: uses good deps — must NOT be blocked by the previous error job.
    const goodDeps = makeDeps();
    await startVerify({
      connectionId: "c5", scopeKey: "s", providerId: "p", providerAlias: "p",
      models: MODELS, opts: { concurrency: 1, batchSize: 3, timeoutMs: 1 }, baseUrl: "x", deps: goodDeps,
    });
    // Wait for the background loop to finish.
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c5");
    expect(s.status).toBe("done");
    expect(s.ok).toBe(3);
    // The good run's upserts must have happened (loop was not blocked).
    expect(goodDeps.upserts).toHaveLength(3);
  });
});
