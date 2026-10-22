import { describe, it, expect } from "vitest";

const { GET, OPTIONS } = await import("../../src/app/api/health/live/route.js");

describe("/api/health/live", () => {
  it("returns 200 without touching the database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, live: true });
  });

  it("keeps the OPTIONS preflight", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });
});
