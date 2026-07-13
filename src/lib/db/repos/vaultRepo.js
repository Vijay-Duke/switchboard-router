import { getAdapter } from "../driver.js";

export const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRIES = 200;
export const FTS_TABLE = "vault_fts";
const MAX_CHUNKS = 2000;

let ftsState = null;

export function resetVaultFtsProbe() {
  ftsState = null;
}

// Test-only seam for exercising the durable LIKE fallback without FTS5.
export function __setFtsStateForTest(value) {
  ftsState = value === null ? null : !!value;
}

function ensureFts(db) {
  if (ftsState !== null) return ftsState;
  try {
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(text, entryId UNINDEXED, chunkIndex UNINDEXED, conversationId UNINDEXED, tokenize='porter unicode61')");
    ftsState = true;
  } catch {
    ftsState = false;
  }
  return ftsState;
}

function tokenise(query) {
  try {
    if (typeof query !== "string") return [];
    return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .filter((token) => token.length >= 2)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function deleteEvicted(db, excess) {
  if (!Number.isInteger(excess) || excess <= 0) return;
  const ids = "SELECT id FROM vault_entries ORDER BY lastAccessedAt ASC LIMIT ?";
  db.run(`DELETE FROM vault_chunks WHERE entryId IN (${ids})`, [excess]);
  if (ensureFts(db)) {
    try { db.run(`DELETE FROM ${FTS_TABLE} WHERE entryId IN (${ids})`, [excess]); } catch {}
  }
  db.run(`DELETE FROM vault_entries WHERE id IN (${ids})`, [excess]);
}

function deleteExpired(db, now) {
  if (typeof now !== "string" || !now) return 0;
  const ids = "SELECT id FROM vault_entries WHERE expiresAt < ?";
  db.run(`DELETE FROM vault_chunks WHERE entryId IN (${ids})`, [now]);
  if (ensureFts(db)) {
    try { db.run(`DELETE FROM ${FTS_TABLE} WHERE entryId IN (${ids})`, [now]); } catch {}
  }
  return db.run(`DELETE FROM vault_entries WHERE expiresAt < ?`, [now])?.changes ?? 0;
}

function touchEntries(db, entryIds, now) {
  if (!Array.isArray(entryIds) || !now) return;
  for (const entryId of entryIds.slice(0, 20)) {
    try { db.run("UPDATE vault_entries SET lastAccessedAt = ? WHERE id = ?", [now, entryId]); } catch {}
  }
}

function annotateToolNames(db, rows) {
  if (!Array.isArray(rows)) return [];
  const names = new Map();
  for (const row of rows.slice(0, 20)) {
    const entryId = row?.entryId;
    if (!entryId || names.has(entryId)) continue;
    try { names.set(entryId, db.get("SELECT toolName FROM vault_entries WHERE id = ?", [entryId])?.toolName ?? null); } catch { names.set(entryId, null); }
  }
  return rows.map((row) => ({
    entryId: row.entryId,
    chunkIndex: row.chunkIndex,
    text: row.text,
    toolName: names.get(row.entryId) ?? null,
  }));
}

function scoreLikeRows(rows, tokens, limit) {
  if (!Array.isArray(rows) || !Array.isArray(tokens)) return [];
  return rows
    .map((row) => ({
      ...row,
      score: tokens.reduce((score, token) => score + Number(String(row?.text || "").toLowerCase().includes(token)), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function putVaultEntry({ id, conversationId, toolName, content, chunks, ttlMs } = {}) {
  try {
    if (typeof id !== "string" || !id || typeof conversationId !== "string" || !conversationId) return false;
    if (typeof content !== "string" || !content) return false;
    const byteLen = Buffer.byteLength(content, "utf8");
    const duration = Number(ttlMs);
    if (byteLen > MAX_ENTRY_BYTES || !Number.isFinite(duration) || duration <= 0) return false;

    const db = await getAdapter();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + duration).toISOString();
    const parts = Array.isArray(chunks) && chunks.length > 0 ? chunks : [content];
    if (parts.length > MAX_CHUNKS) return false;

    db.run(
      `INSERT OR REPLACE INTO vault_entries(id, conversationId, toolName, content, sizeBytes, createdAt, expiresAt, lastAccessedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, conversationId, toolName || null, content, byteLen, now, expiresAt, now],
    );
    db.run("DELETE FROM vault_chunks WHERE entryId = ?", [id]);
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index];
      if (typeof text !== "string") throw new Error("invalid vault chunk");
      db.run("INSERT INTO vault_chunks(entryId, chunkIndex, conversationId, text) VALUES(?, ?, ?, ?)", [id, index, conversationId, text]);
    }

    if (ensureFts(db)) {
      try {
        db.run(`DELETE FROM ${FTS_TABLE} WHERE entryId = ?`, [id]);
        for (let index = 0; index < parts.length; index += 1) {
          db.run(`INSERT INTO ${FTS_TABLE}(text, entryId, chunkIndex, conversationId) VALUES(?, ?, ?, ?)`, [parts[index], id, index, conversationId]);
        }
      } catch {}
    }

    const count = db.get("SELECT COUNT(*) AS count FROM vault_entries")?.count || 0;
    const excess = Number(count) - MAX_ENTRIES;
    if (excess > 0) deleteEvicted(db, excess);
    return true;
  } catch {
    return false;
  }
}

export async function searchVault({ conversationId, query, vaultId = null, limit = 5 } = {}) {
  try {
    if (typeof conversationId !== "string" || !conversationId || typeof query !== "string" || !query.trim()) return [];
    const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 5)));
    const tokens = tokenise(query);
    const db = await getAdapter();
    // Enforce TTL at read time: expired entries must never surface even before
    // the periodic cleanup sweep runs. Both paths join vault_entries.expiresAt.
    const now = new Date().toISOString();
    let rows = [];

    if (tokens.length > 0 && ensureFts(db)) {
      try {
        const match = tokens.map((token) => `"${token}"`).join(" OR ");
        const filters = vaultId ? ` AND ${FTS_TABLE}.entryId = ?` : "";
        const params = vaultId
          ? [match, conversationId, now, vaultId, safeLimit]
          : [match, conversationId, now, safeLimit];
        rows = db.all(
          `SELECT ${FTS_TABLE}.entryId AS entryId, ${FTS_TABLE}.chunkIndex AS chunkIndex, ${FTS_TABLE}.text AS text, bm25(${FTS_TABLE}) AS rank
           FROM ${FTS_TABLE} JOIN vault_entries ON vault_entries.id = ${FTS_TABLE}.entryId
           WHERE ${FTS_TABLE} MATCH ? AND ${FTS_TABLE}.conversationId = ? AND vault_entries.expiresAt > ?${filters} ORDER BY rank LIMIT ?`,
          params,
        );
      } catch {
        rows = [];
      }
    }

    if (rows.length === 0 && tokens.length > 0) {
      const clauses = tokens.map(() => "lower(vault_chunks.text) LIKE ?").join(" OR ");
      const filters = vaultId ? " AND vault_chunks.entryId = ?" : "";
      const params = vaultId
        ? [conversationId, now, vaultId, ...tokens.map((token) => `%${token}%`), safeLimit * 4]
        : [conversationId, now, ...tokens.map((token) => `%${token}%`), safeLimit * 4];
      const found = db.all(
        `SELECT vault_chunks.entryId AS entryId, vault_chunks.chunkIndex AS chunkIndex, vault_chunks.text AS text
         FROM vault_chunks JOIN vault_entries ON vault_entries.id = vault_chunks.entryId
         WHERE vault_chunks.conversationId = ? AND vault_entries.expiresAt > ?${filters} AND (${clauses}) LIMIT ?`,
        params,
      );
      rows = scoreLikeRows(found, tokens, safeLimit);
    }

    const result = annotateToolNames(db, rows.slice(0, safeLimit));
    touchEntries(db, [...new Set(result.map((row) => row.entryId))], new Date().toISOString());
    return result;
  } catch {
    return [];
  }
}

export async function getVaultEntry(id) {
  try {
    if (typeof id !== "string" || !id) return null;
    const db = await getAdapter();
    const row = db.get("SELECT id, conversationId, toolName, content, expiresAt FROM vault_entries WHERE id = ?", [id]);
    if (!row) return null;
    const now = new Date().toISOString();
    if (row.expiresAt < now) {
      try {
        db.run("DELETE FROM vault_chunks WHERE entryId = ?", [id]);
        if (ensureFts(db)) db.run(`DELETE FROM ${FTS_TABLE} WHERE entryId = ?`, [id]);
        db.run("DELETE FROM vault_entries WHERE id = ?", [id]);
      } catch {}
      return null;
    }
    try { db.run("UPDATE vault_entries SET lastAccessedAt = ? WHERE id = ?", [now, id]); } catch {}
    return { id: row.id, conversationId: row.conversationId, toolName: row.toolName, content: row.content };
  } catch {
    return null;
  }
}

export async function cleanupExpiredVault() {
  try {
    const db = await getAdapter();
    return deleteExpired(db, new Date().toISOString());
  } catch {
    return 0;
  }
}
