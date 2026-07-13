// Persisted RTK tool-result vault entries and searchable chunks.

const moduleDefault = {
  version: 7,
  name: "rtk-vault",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        toolName TEXT,
        content TEXT NOT NULL,
        sizeBytes INTEGER,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        lastAccessedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vault_conv ON vault_entries(conversationId);
      CREATE INDEX IF NOT EXISTS idx_vault_expires ON vault_entries(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_vault_last_accessed ON vault_entries(lastAccessedAt);

      CREATE TABLE IF NOT EXISTS vault_chunks (
        entryId TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        conversationId TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (entryId, chunkIndex)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_chunks_conv ON vault_chunks(conversationId);
    `);
  },
};

export default moduleDefault;
