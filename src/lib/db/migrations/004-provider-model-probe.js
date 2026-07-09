// Cache model probe outcomes per provider connection scope.

export default {
  version: 4,
  name: "provider-model-probe",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_model_probe (
        provider_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        model_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'llm',
        status TEXT NOT NULL,
        latency_ms INTEGER,
        failure_class TEXT,
        failure_message TEXT,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, scope_key, kind, model_id)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pmp_provider_scope ON provider_model_probe(provider_id, scope_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pmp_status ON provider_model_probe(provider_id, scope_key, status)`);
  },
};
