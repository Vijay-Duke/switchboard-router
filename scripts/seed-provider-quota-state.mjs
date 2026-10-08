#!/usr/bin/env node
// Offline upgrade migration. Stop Switchboard before running this tool.
// Input is the old /api/usage/<id> JSON response, obtained during its existing
// in-memory cooldown, plus its non-secret identity captured before stopping.
// This tool never contacts any provider or handles tokens.
import fs from "node:fs";
import { createNodeSqliteAdapter } from "../src/lib/db/adapters/nodeSqliteAdapter.js";
import { createProviderQuotaStateStore } from "../src/lib/db/repos/providerQuotaStateStore.js";


const [databaseFile, connectionId, usageFile, identityFile] = process.argv.slice(2);
if (!databaseFile || !connectionId || !usageFile || !identityFile) {
  console.error("Usage: node scripts/seed-provider-quota-state.mjs <existing.sqlite> <connection-id> <old-usage-response.json> <old-connection-identity.json>");
  process.exit(1);
}
let db;
try {
  if (!fs.statSync(databaseFile).isFile()) throw new Error("Existing SQLite database is required.");
  const usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  const retryAt = typeof usage.retryAt === "string" ? Date.parse(usage.retryAt) : NaN;
  if (usage.status !== 429 || usage.code !== "rate_limited" || !Number.isFinite(retryAt) || retryAt <= Date.now()) {
    throw new Error("Input must contain the existing, still-active Claude quota Retry-After.");
  }
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  if (identity.connectionId !== connectionId) throw new Error("Connection identity does not match.");
  db = process.versions.bun
    ? await (await import("../src/lib/db/adapters/bunSqliteAdapter.js")).createBunSqliteAdapter(databaseFile)
    : await createNodeSqliteAdapter(databaseFile);
  const row = db.get("SELECT id, provider, authType, email, createdAt, data FROM providerConnections WHERE id = ?", [connectionId]);
  if (!row || row.provider !== "claude" || !["oauth", "access_token"].includes(row.authType)) {
    throw new Error("Matching Claude subscription connection is required.");
  }
  const store = createProviderQuotaStateStore(async () => db);
  // Old versions did not always record observedAt. Never manufacture one: the
  // deadline remains useful without an eligible last-good quota snapshot.
  const saved = await store.saveProviderQuotaState(identity, {
    retryAt: new Date(retryAt).toISOString(),
    result: usage.observedAt && usage.quotas ? usage : null,
    expiresAt: 0,
  });
  if (!saved) throw new Error("Connection changed; quota state was not written.");
  console.log("Saved the existing Claude quota cooldown and any timestamped last-good snapshot.");
} catch {
  // Do not echo the input response, database row, credentials or parse errors.
  console.error("Quota seed failed. Check the existing database, connection and active cooldown response.");
  process.exitCode = 1;
} finally { db?.close(); }
