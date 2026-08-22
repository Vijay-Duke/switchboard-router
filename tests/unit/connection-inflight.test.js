import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConnectionInFlightCount,
  trackPendingRequest,
} from "../../src/lib/db/repos/usageRepo.js";
import { getConnectionInFlightCount as getFromDb } from "../../src/lib/db/index.js";
import { getConnectionInFlightCount as getFromShim } from "../../src/lib/usageDb.js";

beforeEach(() => {
  global._pendingRequests.byModel = {};
  global._pendingRequests.byAccount = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getConnectionInFlightCount", () => {
  it("sums concurrent models and returns to zero through the existing release contract", () => {
    trackPendingRequest("opus", "anthropic", "c1", true);
    trackPendingRequest("opus", "anthropic", "c1", true);
    trackPendingRequest("haiku", "anthropic", "c1", true);
    trackPendingRequest("opus", "anthropic", "c2", true);
    expect(getConnectionInFlightCount("c1")).toBe(3);
    expect(getConnectionInFlightCount("c2")).toBe(1);

    trackPendingRequest("opus", "anthropic", "c1", false);
    trackPendingRequest("opus", "anthropic", "c1", false);
    trackPendingRequest("haiku", "anthropic", "c1", false);
    trackPendingRequest("opus", "anthropic", "c2", false);
    expect(getConnectionInFlightCount("c1")).toBe(0);
  });

  it("treats missing, negative, and corrupt refcounts as zero", () => {
    global._pendingRequests.byAccount.c1 = { a: -2, b: "bad" };
    expect(getConnectionInFlightCount("missing")).toBe(0);
    expect(getConnectionInFlightCount("c1")).toBe(0);
  });

  it("is re-exported through the database and compatibility interfaces", () => {
    global._pendingRequests.byAccount.c1 = { a: 2 };
    expect(getFromDb("c1")).toBe(2);
    expect(getFromShim("c1")).toBe(2);
  });

  it("keeps work live past sixty seconds until exact completion", () => {
    vi.useFakeTimers();
    trackPendingRequest("opus", "anthropic", "slow", true);

    vi.advanceTimersByTime(61_000);

    expect(getConnectionInFlightCount("slow")).toBe(1);
    trackPendingRequest("opus", "anthropic", "slow", false);
    expect(getConnectionInFlightCount("slow")).toBe(0);
  });
});
