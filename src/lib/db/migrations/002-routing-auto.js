// Auto-route events + learning versions (docs/switchboard/DATABASE.md)

export default {
  version: 2,
  name: "routing-auto",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        comboName TEXT NOT NULL,
        sessionId TEXT,
        requestFingerprint TEXT,
        cluster TEXT,
        routerModel TEXT,
        pickedWorker TEXT,
        alternates TEXT,
        routerReason TEXT,
        routerConfidence TEXT,
        routerLatencyMs INTEGER,
        workerStatus INTEGER,
        workerLatencyMs INTEGER,
        fallbackUsed INTEGER DEFAULT 0,
        retries INTEGER DEFAULT 0,
        tokensIn INTEGER,
        tokensOut INTEGER,
        outcomeScore REAL,
        objective TEXT,
        learningVersionId TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_re_combo_ts ON routing_events(comboName, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_re_cluster_combo ON routing_events(cluster, comboName);
      CREATE INDEX IF NOT EXISTS idx_re_worker ON routing_events(pickedWorker);

      CREATE TABLE IF NOT EXISTS router_learning_versions (
        id TEXT PRIMARY KEY,
        comboName TEXT NOT NULL,
        version INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        source TEXT,
        banditTable TEXT,
        learnedRules TEXT,
        fewShots TEXT,
        evalScore REAL,
        prevVersionId TEXT,
        promoted INTEGER DEFAULT 0,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rlv_combo ON router_learning_versions(comboName);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rlv_combo_ver ON router_learning_versions(comboName, version);
    `);
  },
};
