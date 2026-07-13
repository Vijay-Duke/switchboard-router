// Persisted cache for successful web fetch and search responses.

const moduleDefault = {
  version: 6,
  name: "fetch-cache",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fetchCache (
        cacheKey TEXT PRIMARY KEY,
        kind TEXT,
        url TEXT,
        content TEXT NOT NULL,
        contentType TEXT,
        sizeBytes INTEGER,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        lastAccessedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fc_expires_at ON fetchCache(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_fc_last_accessed_at ON fetchCache(lastAccessedAt);
    `);
  },
};

export default moduleDefault;
