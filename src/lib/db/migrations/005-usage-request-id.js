// Give usageHistory a nullable idempotency key so a double-save of the same
// completed request cannot double-count usage. Replaces the old content-based
// dedupe, which merged distinct requests that shared a millisecond timestamp
// and identical token counts.

function hasColumn(db, table, column) {
  const rows = db.all(`PRAGMA table_info(${table})`) || [];
  return rows.some((r) => r.name === column);
}

const moduleDefault = {
  version: 5,
  name: "usage-request-id",
  up(db) {
    // ALTER TABLE ... ADD COLUMN is not IF NOT EXISTS in SQLite.
    if (!hasColumn(db, "usageHistory", "requestId")) {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN requestId TEXT`);
    }
    // Partial unique: existing rows all have NULL requestId and don't collide.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_request_id ON usageHistory(requestId) WHERE requestId IS NOT NULL`
    );
  },
};

export default moduleDefault;
