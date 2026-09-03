import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ getSettings: vi.fn() }));
const adapter = vi.hoisted(() => ({ transaction: vi.fn(), run: vi.fn() }));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => settings);
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => adapter }));

const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

describe("observability setting", () => {
  it("does not buffer details when the dashboard disables observability", async () => {
    settings.getSettings.mockResolvedValue({ enableObservability: false });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await saveRequestDetail({ model: "test", response: { content: "secret" } });

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe("request detail retention (P12)", () => {
  it("keeps exactly the newest maxRecords rows on flush", async () => {
    // In-memory stand-in for the SQLite adapter: supports only the
    // statements flushToDatabase issues (upsert, cutoff select, range delete).
    const rows = new Map();
    adapter.transaction = (fn) => fn();
    adapter.run = vi.fn((sql, params = []) => {
      if (sql.startsWith("INSERT INTO requestDetails")) {
        const [id, timestamp, provider, model, connectionId, status, data] = params;
        rows.set(id, { id, timestamp, provider, model, connectionId, status, data });
        return { changes: 1 };
      }
      if (sql.startsWith("DELETE FROM requestDetails")) {
        const [cutoff] = params;
        let deleted = 0;
        for (const [id, row] of [...rows]) {
          if (row.timestamp < cutoff) {
            rows.delete(id);
            deleted++;
          }
        }
        return { changes: deleted };
      }
      throw new Error(`unexpected run: ${sql}`);
    });
    adapter.get = vi.fn((sql, params = []) => {
      if (sql.includes("ORDER BY timestamp DESC LIMIT 1 OFFSET")) {
        const [offset] = params;
        const sorted = [...rows.values()].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        return sorted[offset] ? { timestamp: sorted[offset].timestamp } : undefined;
      }
      throw new Error(`unexpected get: ${sql}`);
    });

    settings.getSettings.mockResolvedValue({
      enableObservability: true,
      observabilityMaxRecords: 10,
      observabilityBatchSize: 1000,
      observabilityFlushIntervalMs: 60000,
      observabilityMaxJsonSize: 64,
    });
    // Fresh module instance: the top-level import cached the disabled config.
    const fresh = await import("../../src/lib/db/repos/requestDetailsRepo.js?p12-retention");

    const base = Date.now();
    for (let i = 0; i < 15; i++) {
      await fresh.saveRequestDetail({
        id: `p12-${String(i).padStart(2, "0")}`,
        provider: "test-provider",
        model: "test-model",
        timestamp: new Date(base + i).toISOString(),
        request: { n: i },
        response: { content: `row-${i}` },
      });
    }
    await fresh.flushPendingRequestDetails();

    expect(rows.size).toBe(10);
    expect([...rows.keys()].sort()).toEqual(
      Array.from({ length: 10 }, (_, k) => `p12-${String(k + 5).padStart(2, "0")}`)
    );
  });
});
