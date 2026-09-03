// P1: the usage SSE stream must stay lightweight — it serves only the four
// live fields the client merges, and must never recompute getUsageStats().
import { describe, it, expect, vi, afterEach } from "vitest";

const holder = vi.hoisted(() => ({ current: null }));

vi.mock("@/lib/db/index.js", async () => {
  const { EventEmitter } = await import("node:events");
  const { vi: vitest } = await import("vitest");
  const statsEmitter = new EventEmitter();
  // Exported so a regression that reintroduces its use is caught red-handed.
  const getUsageStats = vitest.fn(async () => ({ __fullReport: true }));
  const getActiveRequests = vitest.fn(async () => ({
    activeRequests: [],
    recentRequests: [],
    errorProvider: "",
    pending: { byModel: {}, byAccount: {} },
  }));
  holder.current = { statsEmitter, getUsageStats, getActiveRequests };
  return { statsEmitter, getUsageStats, getActiveRequests };
});

const { GET } = await import("@/app/api/usage/stream/route.js");

const LIVE_KEYS = ["activeRequests", "errorProvider", "pending", "recentRequests"];

async function readFrame(reader) {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  const text = new TextDecoder().decode(value);
  const match = text.match(/^data: ([\s\S]*)\n\n$/);
  expect(match).not.toBeNull();
  return JSON.parse(match[1]);
}

describe("usage stream route stays lightweight (P1)", () => {
  afterEach(() => {
    holder.current.statsEmitter.removeAllListeners();
    vi.clearAllMocks();
  });

  it("pushes only the four live fields on connect/update/pending, never getUsageStats", async () => {
    const { statsEmitter, getUsageStats, getActiveRequests } = holder.current;

    const res = await GET();
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body.getReader();

    // Initial push on connect.
    const first = await readFrame(reader);
    expect(Object.keys(first).sort()).toEqual(LIVE_KEYS);
    expect(first.pending).toEqual({ byModel: {}, byAccount: {} });
    expect(getActiveRequests).toHaveBeenCalledTimes(1);
    expect(getUsageStats).not.toHaveBeenCalled();

    // Completed request → same lightweight frame, no full recompute.
    statsEmitter.emit("update");
    const second = await readFrame(reader);
    expect(Object.keys(second).sort()).toEqual(LIVE_KEYS);
    expect(getActiveRequests).toHaveBeenCalledTimes(2);
    expect(getUsageStats).not.toHaveBeenCalled();

    // Pending change → same lightweight frame.
    statsEmitter.emit("pending");
    const third = await readFrame(reader);
    expect(Object.keys(third).sort()).toEqual(LIVE_KEYS);
    expect(third.pending).toBeDefined();
    expect(getActiveRequests).toHaveBeenCalledTimes(3);
    expect(getUsageStats).not.toHaveBeenCalled();

    await reader.cancel();
    expect(statsEmitter.listenerCount("update")).toBe(0);
    expect(statsEmitter.listenerCount("pending")).toBe(0);
  });
});
