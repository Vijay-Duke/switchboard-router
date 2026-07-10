// Per-request id on routing_events so COUNT(DISTINCT requestId) is request-level,
// not attempt-level (fallback chains write multiple rows per chat).

const moduleDefault = {
  version: 3,
  name: "routing-request-id",
  up(db) {
    // SQLite: ADD COLUMN is idempotent enough if we guard via pragma
    const cols = db.all(`PRAGMA table_info(routing_events)`);
    const names = new Set((cols || []).map((c) => c.name));
    if (!names.has("requestId")) {
      db.exec(`ALTER TABLE routing_events ADD COLUMN requestId TEXT`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_re_request ON routing_events(comboName, requestId)`
    );
  },
};

export default moduleDefault;
