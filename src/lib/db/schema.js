// Schema version is owned by migrations/index.js → latestVersion().

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
      // Idempotency key: one completed request → one row. Nullable, because
      // callers outside the chat handlers don't mint one.
      requestId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      // Partial: many rows may have NULL requestId, but a present one is unique.
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_request_id ON usageHistory(requestId) WHERE requestId IS NOT NULL",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  fetchCache: {
    columns: {
      cacheKey: "TEXT PRIMARY KEY",
      kind: "TEXT",
      url: "TEXT",
      content: "TEXT NOT NULL",
      contentType: "TEXT",
      sizeBytes: "INTEGER",
      createdAt: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      lastAccessedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_fc_expires_at ON fetchCache(expiresAt)",
      "CREATE INDEX IF NOT EXISTS idx_fc_last_accessed_at ON fetchCache(lastAccessedAt)",
    ],
  },
  vault_entries: {
    columns: {
      id: "TEXT PRIMARY KEY",
      conversationId: "TEXT NOT NULL",
      toolName: "TEXT",
      content: "TEXT NOT NULL",
      sizeBytes: "INTEGER",
      createdAt: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      lastAccessedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_vault_conv ON vault_entries(conversationId)",
      "CREATE INDEX IF NOT EXISTS idx_vault_expires ON vault_entries(expiresAt)",
      "CREATE INDEX IF NOT EXISTS idx_vault_last_accessed ON vault_entries(lastAccessedAt)",
    ],
  },
  vault_chunks: {
    columns: {
      entryId: "TEXT NOT NULL",
      chunkIndex: "INTEGER NOT NULL",
      conversationId: "TEXT NOT NULL",
      text: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (entryId, chunkIndex)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_vault_chunks_conv ON vault_chunks(conversationId)"],
  },
  routing_events: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      comboName: "TEXT NOT NULL",
      sessionId: "TEXT",
      /** Groups attempt rows from one chat request (fallback chain). */
      requestId: "TEXT",
      requestFingerprint: "TEXT",
      cluster: "TEXT",
      routerModel: "TEXT",
      pickedWorker: "TEXT",
      alternates: "TEXT",
      routerReason: "TEXT",
      routerConfidence: "TEXT",
      routerLatencyMs: "INTEGER",
      workerStatus: "INTEGER",
      workerLatencyMs: "INTEGER",
      /**
       * Request-level flag: 1 if this chat used a fallback/rescue at all.
       * Not "this worker retried" — recompute outcomeScore from the row using
       * meta.attemptFallback / scoring inputs, not this column alone.
       */
      fallbackUsed: "INTEGER DEFAULT 0",
      retries: "INTEGER DEFAULT 0",
      tokensIn: "INTEGER",
      tokensOut: "INTEGER",
      outcomeScore: "REAL",
      objective: "TEXT",
      learningVersionId: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_re_combo_ts ON routing_events(comboName, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_re_cluster_combo ON routing_events(cluster, comboName)",
      "CREATE INDEX IF NOT EXISTS idx_re_worker ON routing_events(pickedWorker)",
      "CREATE INDEX IF NOT EXISTS idx_re_request ON routing_events(comboName, requestId)",
    ],
  },
  router_learning_versions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      comboName: "TEXT NOT NULL",
      version: "INTEGER NOT NULL",
      createdAt: "TEXT NOT NULL",
      source: "TEXT",
      banditTable: "TEXT",
      learnedRules: "TEXT",
      fewShots: "TEXT",
      evalScore: "REAL",
      prevVersionId: "TEXT",
      promoted: "INTEGER DEFAULT 0",
      notes: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rlv_combo ON router_learning_versions(comboName)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_rlv_combo_ver ON router_learning_versions(comboName, version)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
