// S7: a rejected DB init must not wedge the process — the next getAdapter()
// retries, and the half-opened adapter is closed before rethrow.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  delete global._dbAdapter;
  vi.resetModules();
});

describe("db driver init retry", () => {
  it("closes the failed adapter, clears the rejected promise, and retries", async () => {
    const closeFirst = vi.fn();
    const firstAdapter = { driver: "mock", close: closeFirst };
    const secondAdapter = { driver: "mock", close: vi.fn() };
    let creates = 0;
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => ({
      createBetterSqliteAdapter: async () => (creates++ === 0 ? firstAdapter : secondAdapter),
    }));
    let migrates = 0;
    vi.doMock("@/lib/db/migrate.js", () => ({
      runMigrationOnce: async () => {
        migrates += 1;
        if (migrates === 1) {
          const err = new Error("database is locked");
          err.code = "SQLITE_BUSY";
          throw err;
        }
      },
    }));

    const { getAdapter } = await import("@/lib/db/driver.js");

    await expect(getAdapter()).rejects.toThrow("database is locked");
    expect(closeFirst).toHaveBeenCalledTimes(1);

    const db = await getAdapter();
    expect(db).toBe(secondAdapter);
    expect(creates).toBe(2);
    expect(migrates).toBe(2);
  });
});
