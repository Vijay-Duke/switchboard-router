import { getAdapter } from "../driver.js";

export const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRIES = 200;

export async function getFetchCache(cacheKey) {
  try {
    const db = await getAdapter();
    const row = db.get(
      `SELECT cacheKey, kind, url, content, contentType, expiresAt FROM fetchCache WHERE cacheKey = ?`,
      [cacheKey],
    );
    if (!row) return null;

    const now = new Date().toISOString();
    if (row.expiresAt < now) {
      try { db.run(`DELETE FROM fetchCache WHERE cacheKey = ?`, [cacheKey]); } catch {}
      return null;
    }

    db.run(`UPDATE fetchCache SET lastAccessedAt = ? WHERE cacheKey = ?`, [now, cacheKey]);
    return { content: row.content, contentType: row.contentType, kind: row.kind, url: row.url };
  } catch {
    return null;
  }
}

export async function putFetchCache({ cacheKey, kind, url, content, contentType, ttlMs }) {
  try {
    if (!content || Buffer.byteLength(content, "utf8") > MAX_ENTRY_BYTES) return;
    const duration = Number(ttlMs);
    if (!Number.isFinite(duration) || duration <= 0) return;

    const db = await getAdapter();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + duration).toISOString();
    db.run(
      `INSERT OR REPLACE INTO fetchCache(
        cacheKey, kind, url, content, contentType, sizeBytes, createdAt, expiresAt, lastAccessedAt
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cacheKey,
        kind || null,
        url || null,
        content,
        contentType || null,
        Buffer.byteLength(content, "utf8"),
        now,
        expiresAt,
        now,
      ],
    );

    const count = db.get(`SELECT COUNT(*) AS count FROM fetchCache`)?.count || 0;
    const excess = Number(count) - MAX_ENTRIES;
    if (excess > 0) {
      db.run(
        `DELETE FROM fetchCache WHERE cacheKey IN (
          SELECT cacheKey FROM fetchCache ORDER BY lastAccessedAt ASC LIMIT ?
        )`,
        [excess],
      );
    }
  } catch {}
}

export async function cleanupExpiredFetchCache() {
  try {
    const db = await getAdapter();
    const result = db.run(`DELETE FROM fetchCache WHERE expiresAt < ?`, [new Date().toISOString()]);
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}
