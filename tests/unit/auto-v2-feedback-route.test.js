/**
 * POST /api/routing/feedback route logic: validation + status mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ setUserRatingByRequestId: vi.fn() }));

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
  jsonError: (status, msg) =>
    new Response(JSON.stringify({ error: msg }), { status }),
  safeErrorMessage: (e, fallback) => e?.message || fallback,
}));
vi.mock("@/lib/db/repos/routingRepo.js", () => ({
  setUserRatingByRequestId: mocks.setUserRatingByRequestId,
}));

const { POST } = await import("../../src/app/api/routing/feedback/route.js");

function post(body) {
  return POST(
    new Request("http://localhost/api/routing/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

describe("feedback route", () => {
  beforeEach(() => mocks.setUserRatingByRequestId.mockReset());

  it("400 when requestId is missing", async () => {
    const res = await post({ rating: 1 });
    expect(res.status).toBe(400);
  });

  it("400 for an out-of-range rating", async () => {
    const res = await post({ requestId: "r1", rating: 5 });
    expect(res.status).toBe(400);
    expect(mocks.setUserRatingByRequestId).not.toHaveBeenCalled();
  });

  it("404 when no terminal event matches", async () => {
    mocks.setUserRatingByRequestId.mockResolvedValue({ updated: 0 });
    const res = await post({ requestId: "gone", rating: 1 });
    expect(res.status).toBe(404);
  });

  it("200 and forwards the rating on success", async () => {
    mocks.setUserRatingByRequestId.mockResolvedValue({ updated: 1 });
    const res = await post({ requestId: "r1", rating: -1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mocks.setUserRatingByRequestId).toHaveBeenCalledWith("r1", -1);
  });

  it("accepts rating 0 (clear)", async () => {
    mocks.setUserRatingByRequestId.mockResolvedValue({ updated: 1 });
    const res = await post({ requestId: "r1", rating: 0 });
    expect(res.status).toBe(200);
    expect(mocks.setUserRatingByRequestId).toHaveBeenCalledWith("r1", 0);
  });
});
