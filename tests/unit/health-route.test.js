// S7: /api/health reports DB readiness for operators; the CLI watchdog uses
// /api/health/live. This route must 503 when the DB is unreachable.
import { describe, it, expect, vi, beforeEach } from "vitest";

const heartbeat = vi.hoisted(() => ({
  startDbHealthHeartbeat: vi.fn(),
  getDbReadinessFromHeartbeat: vi.fn(),
  __setDbHealthHeartbeatSnapshotForTests: vi.fn(),
  __resetDbHealthHeartbeatForTests: vi.fn(),
}));

vi.mock("@/lib/db/dbHealthHeartbeat.js", () => heartbeat);

const { GET, OPTIONS } = await import("../../src/app/api/health/route.js");

describe("health route readiness", () => {
  beforeEach(() => {
    heartbeat.getDbReadinessFromHeartbeat.mockReset();
    heartbeat.startDbHealthHeartbeat.mockClear();
  });

  it("returns 503 ok:false when the heartbeat snapshot is not ready", async () => {
    heartbeat.getDbReadinessFromHeartbeat.mockReturnValueOnce(false);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db", live: true });
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("returns 200 ok:true when the heartbeat snapshot is ready", async () => {
    heartbeat.getDbReadinessFromHeartbeat.mockReturnValueOnce(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, live: true, db: true });
  });

  it("keeps the OPTIONS preflight", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });
});
