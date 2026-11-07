// Upstream #3830: an explicit successful validation / re-login left stale
// model locks, backoff and rate-limit state behind, so a healthy connection
// stayed benched. Switchboard scopes the reset to explicit activation only
// (connection test via resetHealthState, re-login via createProviderConnection)
// so token-refresh writes of testStatus:"active" keep live cooldowns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-health-reset-"));
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;
const db = await import("../../src/lib/db/index.js");

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const STALE = {
  testStatus: "unavailable",
  lastError: "Access denied",
  lastErrorAt: "2026-09-05T00:00:00.000Z",
  errorCode: 403,
  backoffLevel: 3,
  rateLimitedUntil: "2099-01-01T00:00:00.000Z",
  modelLock_modelA: "2099-01-01T00:00:00.000Z",
  modelLock___all: "2099-01-01T00:00:00.000Z",
};

describe("connection health reset on explicit activation", () => {
  it("clears stale routing locks after a successful validation", async () => {
    const c = await db.createProviderConnection({ provider: "hr-validate", authType: "oauth", email: "a@example.com", accessToken: "t" });
    await db.updateProviderConnection(c.id, STALE);
    await db.updateProviderConnection(c.id, { testStatus: "active", lastError: null, lastErrorAt: null, resetHealthState: true });
    const back = await db.getProviderConnectionById(c.id);
    expect(back).toMatchObject({
      testStatus: "active", lastError: null, lastErrorAt: null, errorCode: null,
      backoffLevel: 0, rateLimitedUntil: null, modelLock_modelA: null, modelLock___all: null,
    });
    expect(back.resetHealthState).toBeUndefined();
  });

  it("keeps live cooldowns on a plain testStatus:active write (token refresh)", async () => {
    const c = await db.createProviderConnection({ provider: "hr-refresh", authType: "oauth", email: "b@example.com", accessToken: "t" });
    await db.updateProviderConnection(c.id, STALE);
    await db.updateProviderConnection(c.id, { accessToken: "t2", testStatus: "active" });
    const back = await db.getProviderConnectionById(c.id);
    expect(back.modelLock_modelA).toBe("2099-01-01T00:00:00.000Z");
    expect(back.backoffLevel).toBe(3);
  });

  it("clears stale locks when valid OAuth credentials are re-saved (re-login)", async () => {
    const existing = await db.createProviderConnection({ provider: "hr-resave", authType: "oauth", email: "c@example.com", accessToken: "old" });
    await db.updateProviderConnection(existing.id, STALE);
    const resaved = await db.createProviderConnection({ provider: "hr-resave", authType: "oauth", email: "c@example.com", accessToken: "new", testStatus: "active" });
    expect(resaved.id).toBe(existing.id);
    const back = await db.getProviderConnectionById(existing.id);
    expect(back).toMatchObject({ accessToken: "new", testStatus: "active", lastError: null, errorCode: null, backoffLevel: 0, modelLock_modelA: null });
  });

  it("keeps an explicit soft warning through the reset", async () => {
    const c = await db.createProviderConnection({ provider: "hr-warning", authType: "oauth", email: "d@example.com" });
    await db.updateProviderConnection(c.id, STALE);
    const warningAt = "2026-09-06T00:00:00.000Z";
    await db.updateProviderConnection(c.id, { testStatus: "active", lastError: "Connected, but credits are exhausted", lastErrorAt: warningAt, resetHealthState: true });
    const back = await db.getProviderConnectionById(c.id);
    expect(back).toMatchObject({ testStatus: "active", lastError: "Connected, but credits are exhausted", lastErrorAt: warningAt, modelLock_modelA: null });
  });
});
