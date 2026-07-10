// Sync metadata helpers used during bootstrap, before the shared adapter exists.

export function getMetaSync(adapter, key, fallback = null) {
  const row = adapter.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export function setMetaSync(adapter, key, value) {
  adapter.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}
