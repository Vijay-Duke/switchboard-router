import { beforeEach, describe, expect, it } from "vitest";
import {
  getConnectionInFlightCount,
  trackPendingRequest,
} from "../../src/lib/db/repos/usageRepo.js";
import {
  withConnectionInFlight,
} from "../../src/sse/services/connectionInFlight.js";
import {
  __resetAccountSchedulerForTests,
  selectScheduledConnection,
} from "../../src/sse/services/accountScheduler.js";

beforeEach(() => {
  global._pendingRequests.byModel = {};
  global._pendingRequests.byAccount = {};
  __resetAccountSchedulerForTests();
});

describe("withConnectionInFlight", () => {
  it("keeps a streamed non-chat response counted until EOF", async () => {
    let streamController;
    const response = await withConnectionInFlight({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "c1",
    }, async () => new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    }), { headers: { "x-test": "kept" } }));

    expect(response.headers.get("x-test")).toBe("kept");
    expect(getConnectionInFlightCount("c1")).toBe(1);
    expect(selectScheduledConnection({
      providerId: "openai",
      candidates: [{ id: "c1", maxConcurrentRequests: 1 }],
      getInFlightCount: getConnectionInFlightCount,
    })).toMatchObject({ connection: null, reason: "capacity-exhausted" });

    streamController.enqueue(new TextEncoder().encode("done"));
    streamController.close();
    await expect(response.text()).resolves.toBe("done");
    expect(getConnectionInFlightCount("c1")).toBe(0);
  });

  it("releases exactly once when the client cancels a streamed body", async () => {
    const response = await withConnectionInFlight({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "c1",
    }, async () => new Response(new ReadableStream({ pull() {} })));

    trackPendingRequest("text-embedding-3-small", "openai", "c1", true);
    expect(getConnectionInFlightCount("c1")).toBe(2);
    await response.body.cancel("client closed");
    expect(getConnectionInFlightCount("c1")).toBe(1);
    trackPendingRequest("text-embedding-3-small", "openai", "c1", false);
    expect(getConnectionInFlightCount("c1")).toBe(0);
  });

  it("releases non-response retries and thrown work", async () => {
    await expect(withConnectionInFlight({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "c1",
    }, async () => ({ retry: true }))).resolves.toEqual({ retry: true });
    expect(getConnectionInFlightCount("c1")).toBe(0);

    await expect(withConnectionInFlight({
      provider: "openai",
      model: "text-embedding-3-small",
      connectionId: "c1",
    }, async () => {
      throw new Error("upstream failed");
    })).rejects.toThrow("upstream failed");
    expect(getConnectionInFlightCount("c1")).toBe(0);
  });
});
