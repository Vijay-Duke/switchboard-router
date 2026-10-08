import { createHash } from "node:crypto";
import { getQuotaStateIdentity, sanitizeQuotaState, mergeQuotaState } from "../../../../open-sse/services/usage/quotaState.js";

export const PROVIDER_QUOTA_STATE_SCOPE = "providerQuotaState";
const identityHash = identity => createHash("sha256").update(JSON.stringify(
  ["connectionId", "provider", "authType", "createdAt", "email", "accountId", "organizationId"]
    .map(key => typeof identity?.[key] === "string" ? identity[key] : "")
)).digest("hex");

function currentIdentity(db, expected) {
  if (!expected?.connectionId || !expected.provider || !expected.authType || !expected.createdAt) return null;
  const row = db.get("SELECT id, provider, authType, email, createdAt, data FROM providerConnections WHERE id = ?", [expected.connectionId]);
  if (!row) return null;
  let data;
  try { data = JSON.parse(row.data); } catch { return null; }
  const identity = getQuotaStateIdentity({ ...row, providerSpecificData: data?.providerSpecificData });
  return identityHash(identity) === identityHash(expected) ? identityHash(identity) : null;
}

// Separate namespace in durable SQLite kv, not the evictable web-fetch cache.
// The factory also permits an offline upgrade seed without loading Next or auth.
export function createProviderQuotaStateStore(getAdapter) {
  return {
    async loadProviderQuotaState(identity) {
      const db = await getAdapter();
      const binding = currentIdentity(db, identity);
      if (!binding) return { invalidIdentity: true };
      const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [PROVIDER_QUOTA_STATE_SCOPE, identity.connectionId]);
      let stored;
      try { stored = JSON.parse(row?.value || "null"); } catch { throw new Error("Invalid durable quota state"); }
      if (stored && stored.version !== 1) throw new Error("Unsupported durable quota state");
      return stored?.version === 1 && stored.binding === binding ? sanitizeQuotaState(stored) : sanitizeQuotaState(null);
    },
    async saveProviderQuotaState(identity, incoming) {
      const db = await getAdapter();
      let saved = false;
      db.transaction(() => {
        const binding = currentIdentity(db, identity);
        if (!binding) return;
        const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [PROVIDER_QUOTA_STATE_SCOPE, identity.connectionId]);
        let old;
        try { old = JSON.parse(row?.value || "null"); } catch { old = null; }
        if (old?.version !== 1 || old.binding !== binding) old = null;
        const state = { version: 1, binding, ...mergeQuotaState(old, incoming) };
        db.run("INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value", [PROVIDER_QUOTA_STATE_SCOPE, identity.connectionId, JSON.stringify(state)]);
        saved = true;
      });
      return saved;
    },
  };
}
