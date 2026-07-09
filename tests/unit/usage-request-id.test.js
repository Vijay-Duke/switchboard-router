import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-reqid-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const entry = (over = {}) => ({
  provider: "openai",
  model: "gpt-4",
  connectionId: "c1",
  tokens: { prompt_tokens: 10, completion_tokens: 5 },
  endpoint: "/v1/chat",
  status: "ok",
  ...over,
});

describe("usageHistory requestId idempotency", () => {
  it("a replayed save with the same requestId counts once, quietly", async () => {
    // The UNIQUE index alone would also keep the count at 1 — by throwing and
    // rolling back on every replay. Assert the in-transaction guard short-
    // circuits first, so a replay is a silent no-op and not an error per call.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await db.saveRequestUsage(entry({ requestId: "req-dup" }));
    await db.saveRequestUsage(entry({ requestId: "req-dup" }));
    await db.saveRequestUsage(entry({ requestId: "req-dup" }));

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBe(1);

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(1);
    expect(stats.byProvider.openai.promptTokens).toBe(10);
  });

  it("distinct requestIds each count, even with identical content and timestamp", async () => {
    const ts = new Date().toISOString();
    await Promise.all([
      db.saveRequestUsage(entry({ provider: "anthropic", requestId: "a-1", timestamp: ts })),
      db.saveRequestUsage(entry({ provider: "anthropic", requestId: "a-2", timestamp: ts })),
      db.saveRequestUsage(entry({ provider: "anthropic", requestId: "a-3", timestamp: ts })),
    ]);

    const hist = await db.getUsageHistory({ provider: "anthropic" });
    expect(hist.length).toBe(3);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider.anthropic.requests).toBe(3);
  });

  it("saves without a requestId always insert (no content dedupe)", async () => {
    const ts = new Date().toISOString();
    await db.saveRequestUsage(entry({ provider: "google", timestamp: ts }));
    await db.saveRequestUsage(entry({ provider: "google", timestamp: ts }));

    const hist = await db.getUsageHistory({ provider: "google" });
    expect(hist.length).toBe(2);
  });

  it("enforces uniqueness at the schema level, not just in JS", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const idx = adapter.all(`PRAGMA index_list('usageHistory')`) || [];
    const unique = idx.find((i) => i.name === "idx_uh_request_id");
    expect(unique).toBeDefined();
    expect(unique.unique).toBe(1);

    expect(() =>
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, requestId) VALUES(?, ?, ?)`,
        [new Date().toISOString(), "openai", "req-dup"]
      )
    ).toThrow(/UNIQUE/i);
  });
});
