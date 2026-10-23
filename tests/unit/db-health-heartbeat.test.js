import { describe, it, expect, vi, beforeEach } from "vitest";

const driver = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock("@/lib/db/driver.js", () => driver);

const {
  __resetDbHealthHeartbeatForTests,
  __setDbHealthHeartbeatSnapshotForTests,
  getDbReadinessFromHeartbeat,
  startDbHealthHeartbeat,
  READINESS_STALE_MS,
} = await import("../../src/lib/db/dbHealthHeartbeat.js");

describe("db health heartbeat", () => {
  beforeEach(() => {
    __resetDbHealthHeartbeatForTests();
    driver.getAdapter.mockReset();
  });

  it("reports not ready before the first successful probe", () => {
    expect(getDbReadinessFromHeartbeat()).toBe(false);
  });

  it("reports ready from a fresh successful snapshot", () => {
    __setDbHealthHeartbeatSnapshotForTests({ ok: true, updatedAt: Date.now() });
    expect(getDbReadinessFromHeartbeat()).toBe(true);
  });

  it("reports not ready when the snapshot is stale", () => {
    __setDbHealthHeartbeatSnapshotForTests({
      ok: true,
      updatedAt: Date.now() - READINESS_STALE_MS - 1,
    });
    expect(getDbReadinessFromHeartbeat()).toBe(false);
  });

  it("runs a probe without throwing when getAdapter resolves", async () => {
    driver.getAdapter.mockResolvedValueOnce({ get: () => ({ 1: 1 }) });
    startDbHealthHeartbeat();
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.getAdapter).toHaveBeenCalled();
  });
});
