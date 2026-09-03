// S7: /api/health is the watchdog readiness probe — it must 503 when the DB
// is unreachable instead of reporting ok while every route 500s.
import { describe, it, expect, vi } from "vitest";

const driver = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => driver);

const { GET, OPTIONS } = await import("../../src/app/api/health/route.js");

describe("health route readiness", () => {
  it("returns 503 ok:false when getAdapter rejects", async () => {
    driver.getAdapter.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("returns 200 ok:true when the DB answers", async () => {
    driver.getAdapter.mockResolvedValueOnce({ get: () => ({ "1": 1 }) });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 when the DB hangs past the probe timeout", async () => {
    driver.getAdapter.mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const res = await GET();
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db" });
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(15000);
  }, 20000);

  it("keeps the OPTIONS preflight", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });
});
