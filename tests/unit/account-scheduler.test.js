import { beforeEach, describe, expect, it } from "vitest";
import {
  selectScheduledConnection,
  __resetAccountSchedulerForTests,
} from "../../src/sse/services/accountScheduler.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const connection = (id, extra = {}) => ({ id, priority: 1, ...extra });
const counts = (values) => (id) => values[id] || 0;

beforeEach(() => __resetAccountSchedulerForTests());

describe("selectScheduledConnection", () => {
  it("chooses least inflight before quota and priority", () => {
    const result = selectScheduledConnection({
      providerId: "anthropic",
      candidates: [
        connection("busy", { priority: 1, lastQuota: { at: NOW, remainingPercentage: 100 } }),
        connection("idle", { priority: 9, lastQuota: { at: NOW, remainingPercentage: 5 } }),
      ],
      getInFlightCount: counts({ busy: 2, idle: 0 }),
      now: NOW,
    });
    expect(result).toMatchObject({ connection: { id: "idle" }, reason: "least-inflight" });
  });

  it("uses fresh quota and ignores stale quota", () => {
    const fresh = selectScheduledConnection({
      providerId: "p",
      candidates: [
        connection("low", { lastQuota: { at: NOW, remainingPercentage: 20 } }),
        connection("high", { lastQuota: { at: NOW, remainingPercentage: 80 } }),
      ],
      getInFlightCount: counts({}),
      now: NOW,
    });
    expect(fresh).toMatchObject({ connection: { id: "high" }, reason: "quota-headroom" });

    const stale = selectScheduledConnection({
      providerId: "p",
      candidates: [
        connection("z", { priority: 1, lastQuota: { at: NOW - 999_999, remainingPercentage: 100 } }),
        connection("a", { priority: 1 }),
      ],
      quotaFreshMs: 1_000,
      getInFlightCount: counts({}),
      now: NOW,
    });
    expect(stale).toMatchObject({ connection: { id: "a" }, reason: "connection-id" });
  });

  it("prefers unknown quota over fresh exhaustion and earliest future reset among exhausted accounts", () => {
    const unknown = connection("unknown", { priority: 9 });
    const exhausted = connection("exhausted", {
      priority: 1,
      lastQuota: { at: NOW, remainingPercentage: 0, resetAt: new Date(NOW + 5_000).toISOString() },
    });
    expect(selectScheduledConnection({
      providerId: "p",
      candidates: [exhausted, unknown],
      getInFlightCount: counts({}),
      now: NOW,
    }).connection.id).toBe("unknown");

    const result = selectScheduledConnection({
      providerId: "p",
      candidates: [
        exhausted,
        connection("sooner", {
          lastQuota: { at: NOW, remainingPercentage: 0, resetAt: new Date(NOW + 1_000).toISOString() },
        }),
      ],
      getInFlightCount: counts({}),
      now: NOW,
    });
    expect(result).toMatchObject({ connection: { id: "sooner" }, reason: "quota-reset" });
  });

  it("uses priority then connection id for deterministic ties regardless of input order", () => {
    const options = {
      providerId: "p",
      getInFlightCount: counts({}),
      now: NOW,
    };
    expect(selectScheduledConnection({
      ...options,
      candidates: [connection("z", { priority: 2 }), connection("a", { priority: 1 })],
    })).toMatchObject({ connection: { id: "a" }, reason: "priority" });
    expect(selectScheduledConnection({
      ...options,
      candidates: [connection("z"), connection("a")],
    })).toMatchObject({ connection: { id: "a" }, reason: "connection-id" });
    expect(selectScheduledConnection({
      ...options,
      candidates: [connection("a"), connection("z")],
    })).toMatchObject({ connection: { id: "a" }, reason: "connection-id" });
  });

  it("filters positive connection caps and reports all-capped best-effort capacity", () => {
    expect(selectScheduledConnection({
      providerId: "p",
      candidates: [
        connection("capped", { maxConcurrentRequests: 1 }),
        connection("unlimited", { maxConcurrentRequests: null }),
      ],
      getInFlightCount: counts({ capped: 1, unlimited: 9 }),
      now: NOW,
    })).toMatchObject({ connection: { id: "unlimited" } });

    expect(selectScheduledConnection({
      providerId: "p",
      candidates: [
        connection("a", { maxConcurrentRequests: 1 }),
        connection("b", { maxConcurrentRequests: 2 }),
      ],
      getInFlightCount: counts({ a: 1, b: 2 }),
      now: NOW,
    })).toEqual({
      connection: null,
      reason: "capacity-exhausted",
      affinityRebound: false,
      capacityLimited: true,
    });
  });

  it("keeps a session on its healthy account even when another account becomes less busy", () => {
    const first = selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "conversation-1",
      getInFlightCount: counts({ a: 0, b: 1 }),
      now: NOW,
    });
    expect(first.connection.id).toBe("a");

    const second = selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "conversation-1",
      getInFlightCount: counts({ a: 9, b: 0 }),
      now: NOW + 1,
    });
    expect(second).toMatchObject({
      connection: { id: "a" },
      reason: "session-affinity",
      affinityRebound: false,
    });
  });

  it("scopes affinity by provider", () => {
    selectScheduledConnection({
      providerId: "p1",
      candidates: [connection("a"), connection("b")],
      sessionKey: "same-session",
      getInFlightCount: counts({ a: 0, b: 1 }),
      now: NOW,
    });
    const other = selectScheduledConnection({
      providerId: "p2",
      candidates: [connection("a"), connection("b")],
      sessionKey: "same-session",
      getInFlightCount: counts({ a: 5, b: 0 }),
      now: NOW + 1,
    });
    expect(other).toMatchObject({ connection: { id: "b" }, reason: "least-inflight" });
  });

  it("expires affinity and scores again", () => {
    const options = {
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "s",
      affinityTtlMs: 100,
    };
    selectScheduledConnection({ ...options, getInFlightCount: counts({ a: 0, b: 1 }), now: NOW });
    const result = selectScheduledConnection({
      ...options,
      getInFlightCount: counts({ a: 5, b: 0 }),
      now: NOW + 101,
    });
    expect(result).toMatchObject({
      connection: { id: "b" },
      reason: "least-inflight",
      affinityRebound: false,
    });
  });

  it("rebinds when a live bound account is filtered or capped", () => {
    selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "s",
      getInFlightCount: counts({ a: 0, b: 1 }),
      now: NOW,
    });
    const filtered = selectScheduledConnection({
      providerId: "p",
      candidates: [connection("b")],
      sessionKey: "s",
      getInFlightCount: counts({}),
      now: NOW + 1,
    });
    expect(filtered).toMatchObject({ connection: { id: "b" }, affinityRebound: true });

    __resetAccountSchedulerForTests();
    selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "capped",
      getInFlightCount: counts({ a: 0, b: 1 }),
      now: NOW,
    });
    const capped = selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a", { maxConcurrentRequests: 1 }), connection("b")],
      sessionKey: "capped",
      getInFlightCount: counts({ a: 1, b: 0 }),
      now: NOW + 2,
    });
    expect(capped).toMatchObject({ connection: { id: "b" }, affinityRebound: true });
  });

  it("bounds affinity state by evicting the oldest entry", () => {
    for (let index = 0; index < 5_001; index += 1) {
      selectScheduledConnection({
        providerId: "p",
        candidates: [connection("a"), connection("b")],
        sessionKey: `session-${index}`,
        getInFlightCount: counts({ a: 0, b: 1 }),
        now: NOW + index,
      });
    }
    const result = selectScheduledConnection({
      providerId: "p",
      candidates: [connection("a"), connection("b")],
      sessionKey: "session-0",
      getInFlightCount: counts({ a: 5, b: 0 }),
      now: NOW + 5_002,
    });
    expect(result).toMatchObject({ connection: { id: "b" }, reason: "least-inflight" });
  });

  it("reports no candidates without capacity exhaustion", () => {
    expect(selectScheduledConnection({ providerId: "p", candidates: [] })).toEqual({
      connection: null,
      reason: "no-candidates",
      affinityRebound: false,
      capacityLimited: false,
    });
  });
});
