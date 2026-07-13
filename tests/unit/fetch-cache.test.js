import { beforeEach, describe, expect, it, vi } from "vitest";

const store = { rows: new Map() };
let adapterFails = false;

function copy(row) {
  return row ? { ...row } : null;
}

const db = {
  get(sql, params = []) {
    if (sql.includes("FROM fetchCache WHERE cacheKey = ?")) return copy(store.rows.get(params[0]));
    if (sql.includes("COUNT(*) AS count FROM fetchCache")) return { count: store.rows.size };
    return null;
  },
  run(sql, params = []) {
    if (sql.includes("INSERT OR REPLACE INTO fetchCache")) {
      const [cacheKey, kind, url, content, contentType, sizeBytes, createdAt, expiresAt, lastAccessedAt] = params;
      store.rows.set(cacheKey, { cacheKey, kind, url, content, contentType, sizeBytes, createdAt, expiresAt, lastAccessedAt });
      return { changes: 1 };
    }
    if (sql.includes("UPDATE fetchCache SET lastAccessedAt")) {
      const row = store.rows.get(params[1]);
      if (!row) return { changes: 0 };
      row.lastAccessedAt = params[0];
      return { changes: 1 };
    }
    if (sql.includes("WHERE cacheKey IN")) {
      const count = params[0];
      [...store.rows.values()]
        .sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt))
        .slice(0, count)
        .forEach((row) => store.rows.delete(row.cacheKey));
      return { changes: count };
    }
    if (sql.includes("WHERE cacheKey = ?")) return { changes: Number(store.rows.delete(params[0])) };
    if (sql.includes("WHERE expiresAt < ?")) {
      let changes = 0;
      for (const [key, row] of store.rows) {
        if (row.expiresAt < params[0]) {
          store.rows.delete(key);
          changes += 1;
        }
      }
      return { changes };
    }
    return { changes: 0 };
  },
};

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => {
    if (adapterFails) throw new Error("database unavailable");
    return db;
  }),
}));

const { MAX_ENTRIES, MAX_ENTRY_BYTES, cleanupExpiredFetchCache, getFetchCache, putFetchCache } = await import(
  "../../src/lib/db/repos/fetchCacheRepo.js"
);

beforeEach(() => {
  store.rows.clear();
  adapterFails = false;
  vi.useRealTimers();
});

describe("fetchCacheRepo", () => {
  it("stores and retrieves content, but treats expired entries as misses", async () => {
    await putFetchCache({
      cacheKey: "live",
      kind: "fetch",
      url: "https://example.test",
      content: "cached content",
      contentType: "text/plain",
      ttlMs: 60_000,
    });
    await expect(getFetchCache("live")).resolves.toMatchObject({ content: "cached content", contentType: "text/plain" });

    store.rows.set("expired", {
      cacheKey: "expired",
      content: "old content",
      contentType: "text/plain",
      kind: "fetch",
      url: "https://example.test/old",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
    await expect(getFetchCache("expired")).resolves.toBeNull();
    expect(store.rows.has("expired")).toBe(false);
  });

  it("does not store oversized content", async () => {
    await putFetchCache({
      cacheKey: "oversized",
      kind: "fetch",
      url: "https://example.test",
      content: "x".repeat(MAX_ENTRY_BYTES + 1),
      contentType: "text/plain",
      ttlMs: 60_000,
    });
    await expect(getFetchCache("oversized")).resolves.toBeNull();
  });

  it("caps the cache and evicts least-recently-accessed entries", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      vi.setSystemTime(new Date(start.getTime() + i));
      await putFetchCache({
        cacheKey: `entry-${i}`,
        kind: "search",
        url: `query ${i}`,
        content: `content ${i}`,
        contentType: "application/json",
        ttlMs: 60_000,
      });
    }
    vi.setSystemTime(new Date(start.getTime() + MAX_ENTRIES + 1));
    await getFetchCache("entry-0");

    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(new Date(start.getTime() + MAX_ENTRIES + 2 + i));
      await putFetchCache({
        cacheKey: `new-${i}`,
        kind: "search",
        url: `new query ${i}`,
        content: `new content ${i}`,
        contentType: "application/json",
        ttlMs: 60_000,
      });
    }

    expect(store.rows.size).toBe(MAX_ENTRIES);
    expect(store.rows.has("entry-0")).toBe(true);
    for (let i = 1; i <= 5; i += 1) expect(store.rows.has(`entry-${i}`)).toBe(false);
  });

  it("removes only expired entries during cleanup", async () => {
    const now = Date.now();
    store.rows.set("expired", { cacheKey: "expired", expiresAt: new Date(now - 1).toISOString() });
    store.rows.set("live", { cacheKey: "live", expiresAt: new Date(now + 60_000).toISOString() });

    await expect(cleanupExpiredFetchCache()).resolves.toBe(1);
    expect([...store.rows.keys()]).toEqual(["live"]);
  });

  it("fails open when the database is unavailable", async () => {
    adapterFails = true;
    await expect(getFetchCache("missing")).resolves.toBeNull();
    await expect(putFetchCache({
      cacheKey: "unavailable",
      kind: "fetch",
      url: "https://example.test",
      content: "content",
      contentType: "text/plain",
      ttlMs: 60_000,
    })).resolves.toBeUndefined();
  });
});
