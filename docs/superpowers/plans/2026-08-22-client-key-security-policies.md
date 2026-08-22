# Client-Key Security and Bounded Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace reusable gateway-key usage attribution with stable non-secret key IDs, scrub historical usage, and enforce bounded per-key model/combo, expiration, request-rate, concurrency, and already-spent policies without breaking existing keys or local no-key operation.

**Architecture:** `apiKeys.id` becomes the only persisted/runtime attribution identity; a raw key exists only long enough to authenticate against the existing hashed record. Migration 8 rewrites usage history/daily data. One process-local policy service authenticates, checks persisted policy, acquires a rate/concurrency lease, and releases it through normal, streaming, abort, and error completion.

**Tech Stack:** JavaScript ESM, Next.js 16/React 19, existing SQLite adapters, Web `Response`/`ReadableStream`, Vitest 4; no new packages.

**Spec:** Approved 2026-08-22 bounded-priorities task brief (no separate design file).

## Global Constraints

- Work only in `/Users/vijay/IdeaProjects/switchboard/.worktrees/gateway-priorities` on `feat/gateway-priorities`.
- Preserve generated keys, legacy plaintext `apiKeys` rows, CLI-token bypass, verified-loopback bypass, and `requireApiKey: false` no-key mode.
- Do not add users/teams, billing, RBAC/SSO, distributed state, proxy pools, caching, MCP aggregation, or a new API family.
- Raw/reusable gateway keys must not reach usage tables, daily JSON, request details, logs, aggregate metrics, or management metrics.
- Policy counters are process-local: restart resets rate/in-flight state; persisted spend survives.
- This task lands first. Scheduler may later add `getConnectionInFlightCount(connectionId)` without changing this plan's identity fields. Prometheus must not label by key ID/name/prefix.

---

## Locked Data and Interface Contracts

### `ClientKeyRecord`

```js
{
  id: string,
  keyPrefix: string,
  name: string,
  machineId: string | null,
  isActive: boolean,
  createdAt: string,
  allowedModels: string[],
  allowedCombos: string[],
  expiresAt: string | null,
  rateLimitPerMinute: number | null,
  concurrencyLimit: number | null,
  spendLimitUsd: number | null,
  spentUsd: number,
}
```

Only `createApiKey()` adds `key` containing the full new secret, returned once. List/detail/authentication never do.

SQLite `apiKeys` gains nullable `allowedModels TEXT` and `allowedCombos TEXT` (JSON arrays), `expiresAt TEXT`, `rateLimitPerMinute INTEGER`, `concurrencyLimit INTEGER`, and `spendLimitUsd REAL`. Existing rows remain unrestricted (`NULL`). Bounds:

```js
export const CLIENT_KEY_POLICY_BOUNDS = Object.freeze({
  maxAllowlistEntries: 100,
  maxTargetLength: 256,
  maxRatePerMinute: 60_000,
  maxConcurrency: 1_000,
  maxSpendUsd: 1_000_000,
});
```

Arrays are trimmed/de-duplicated, retain order, and reject too many/long entries. Expiration is null/empty or a valid ISO instant; past is allowed and immediately expired. Rate/concurrency are null or integers from 1 through their max. Spend is null or finite from 0 through its max.

### Usage identity

- Replace `usageHistory.apiKey` with nullable `clientKeyId TEXT`, deliberately without a foreign key so deleted-key history survives.
- Runtime `saveRequestUsage` accepts `clientKeyId`, never raw key.
- `NULL` means local/no-key or unmatched old attribution. Do not retain an unknown-key hash/prefix.
- `usageDaily.data.byClientKey` replaces `byApiKey`; key is `${clientKeyId || "local-no-key"}|${model}|${provider || "unknown"}` and metadata has only `clientKeyId`, `rawModel`, `provider`.
- Public `getUsageStats().byApiKey` may keep its product-facing name, but entries contain `clientKeyId`, `keyName`, and usage fields only—no `apiKey`, `apiKeyMasked`, or `apiKeyKey`.
- Migration maps known historical plaintext to `apiKeys.id` by `hashApiKey(raw)` versus unpacked stored hash; unmatched becomes null.

### Policy service

Create `src/sse/services/clientKeyPolicy.js`:

```js
// target: { kind: "model" | "combo", id: string } | null
export async function authorizeClientKeyRequest({ settings, rawKey, request, target });
// result:
// { ok:true, mode:"local"|"cli", clientKey:null, clientKeyId:null, lease:null }
// { ok:true, mode:"api-key", clientKey:ClientKeyRecord, clientKeyId:string, lease:{release()} }
// { ok:false, response:Response }
export async function runWithClientKeyLease(lease, work); // Promise<Response>
export function __resetClientKeyPolicyStateForTests();
```

Order is exact:

1. Verified loopback or valid CLI token bypasses with null identity/lease (even if a key header exists).
2. Missing key: optional mode becomes local; required mode returns 401 `missing_api_key`.
3. Invalid/inactive supplied key: optional mode remains local (legacy opt-out); required mode returns 401 `invalid_api_key`.
4. `expiresAt <= now`: 403 `client_key_expired`.
5. If either allowlist is non-empty, models must be in `allowedModels`, combos in `allowedCombos`: otherwise 403 `client_key_target_not_allowed`. Combo workers need not be separately allowed.
6. `SUM(usageHistory.cost)` already at/above limit: 429 `client_key_spend_limit_exceeded`. This is not a reservation; one accepted request may cross the ceiling.
7. In-flight at limit: 429 `client_key_concurrency_limit_exceeded`, `Retry-After: 1`.
8. Accepted starts in the key's fixed 60-second window at limit: 429 `client_key_rate_limit_exceeded`, `Retry-After` is ceiling of remaining seconds.
9. Accepted requests synchronously increment rate and in-flight after the last awaited check and receive an idempotent lease.

Policy errors use:

```json
{"error":{"message":"API key policy rejected this request","type":"client_key_policy_error","code":"client_key_rate_limit_exceeded"}}
```

Never include raw key, prefix, name, current spend, or configured limit in error/log text.

Lease rules: non-SSE releases when handler produces final response; SSE wraps the body and releases on EOF, source error, or consumer cancel; cancel also cancels source reader; thrown/rejected work releases then rethrows; release is idempotent and clamps at zero. No provider/account/combo rotation begins before acquisition.

Target classification: chat/image/TTS reuse `getComboModels`; fetch/search reuse existing combo lookup; embeddings/STT are model; Gemini native uses `gemini/${normalizeGeminiNativeModel(model)}`. Model-listing, count-token, health/dashboard/management routes do not acquire because they start no provider work.

## Exact Current Seams

- `src/lib/db/schema.js:73-137`: current `apiKeys`, raw `usageHistory.apiKey`, `usageDaily`.
- `src/lib/db/migrations/index.js:1-15`, `src/lib/db/migrate.js:62-115,149-200,224-297`: registry/runner/imports.
- `src/lib/crypto/secrets.js:78-111`: packed hash format and constant-time compare.
- `src/lib/db/repos/apiKeysRepo.js:14-111`: safe projection/CRUD/legacy upgrade.
- `src/lib/db/index.js:28-31,114-212`: exports and backup import/export.
- `src/lib/db/repos/usageRepo.js:82-150,281-395,407-725`: daily/history/stats raw attribution.
- `src/sse/utils/requireApiKeyGate.js:1-51`: old boolean handler gate to replace.
- `src/dashboardGuard.js:155-181,210-227`: retain coarse public-route prefilter.
- `src/sse/services/auth.js:321-324`: remove handler `isValidApiKey` wrapper.
- `src/sse/handlers/chat.js:205-497,511-839` and `open-sse/handlers/chatCore.js:54-129,463-487`: auth, feedback/vault identity, usage handoff.
- `open-sse/handlers/chatCore/{requestDetail,nonStreamingHandler,sseToJsonHandler,streamingHandler}.js` and `open-sse/utils/stream.js:32-80,549-575`: raw usage key propagation.
- `src/sse/handlers/{embeddings,fetch,imageGeneration,search,stt,tts}.js`: all shared-gate consumers.
- `src/app/api/v1beta/models/[...path]/route.js:180-195,237-239`: separate Gemini gate.
- `open-sse/utils/requestLogger.js:77-95,134-180`, `open-sse/config/appConstants.js:75-88`, `src/lib/db/repos/requestDetailsRepo.js:62-110`: log/persistence redaction.
- `src/app/api/keys/route.js:8-42`, `src/app/api/keys/[id]/route.js:5-58`: key API.
- `src/lib/dashboard/loaders.js:53-68`, `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js:31-363`: key UI.
- `src/shared/components/UsageStats.js:118-175,383-400`: key usage display.
- Relevant conventions/tests: `db-migration-chain.test.js`, `db-sqlite-vs-lowdb.test.js`, `require-api-key-gate.test.js`, `dashboard-polish.test.js`, `request-logger-redaction.test.js`, `responses-abort-terminal.test.js`.

---

### Task 1: Migration 8—identity scrub with preservation and rollback proof

**Files:**
- Create: `src/lib/db/migrations/008-client-key-identity.js`
- Modify: `src/lib/db/migrations/index.js:1-15`
- Modify: `src/lib/db/migrate.js:62-81`
- Modify: `src/lib/db/schema.js:73-137`
- Test: `tests/unit/client-key-migration.test.js`
- Test: `tests/unit/db-migration-chain.test.js`

**Interfaces:** Produces `{version:8,name:"client-key-identity",up(db),down(db),afterUp(db)}` and current schema/policy columns.

- [ ] **Step 1: Write the failing migration fixture**

Seed a version-7 DB with a packed key, plaintext legacy key, known/local/unmatched history and matching `byApiKey` daily entries. Capture row count, IDs, request IDs, token sums, cost sum, and every non-key daily breakdown. After migration assert known rows map to IDs, local/unmatched map null, `apiKey` column is gone, `byApiKey` is gone, all captured values match, request-ID index remains unique, and the next autoincrement ID exceeds the old maximum.

```js
expect(columns("usageHistory")).toContain("clientKeyId");
expect(columns("usageHistory")).not.toContain("apiKey");
expect(JSON.stringify(JSON.parse(daily.data))).not.toContain(RAW_KEY);
expect(afterTotals).toEqual(beforeTotals);
```

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-migration.test.js
```

Expected: FAIL because migration 8/`clientKeyId` do not exist.

- [ ] **Step 3: Implement the migration**

`up()` enables `PRAGMA secure_delete=ON`, adds policy columns if absent, loads keys once, rebuilds `usageHistory` with explicit IDs and `clientKeyId`, recreates `idx_uh_ts/provider/model/conn/client_key/request_id`, rewrites/merges daily key counters, and asserts captured row/token/cost totals before returning. Resolve with:

```js
function resolveClientKeyId(raw, keys) {
  if (!raw || raw === "local-no-key") return null;
  const hash = hashApiKey(String(raw));
  for (const k of keys) {
    const u = unpackApiKeyRecord(k.key);
    if (!u.legacy && u.hash && timingSafeEqualStr(u.hash, hash)) return k.id;
    if (u.legacy && timingSafeEqualStr(String(u.raw || ""), String(raw))) return k.id;
  }
  return null;
}
```

`down()` rebuilds version-7 history with `apiKey=NULL` and secret-free daily `byApiKey`, preserving all totals/IDs but intentionally not reconstructing secrets. `afterUp()` runs `checkpoint?.()`, `VACUUM`, then checkpoint.

- [ ] **Step 4: Extend runner safely**

Run each migration as:

```js
adapter.transaction(() => m.up(adapter));
if (typeof m.afterUp === "function") m.afterUp(adapter);
adapter.transaction(() => setMetaSync(adapter, "schemaVersion", m.version));
```

An `up` failure rolls back and leaves version 7. An `afterUp` failure also leaves 7; `up()` must detect already-upgraded columns and safely reassert/retry.

- [ ] **Step 5: Register schema/version and prove round trip**

Add policy columns, replace usage `apiKey` with `clientKeyId`, add index, register `m008`. Test `up` twice, `down`, then `up`; prove identical non-secret data/totals and no raw key bytes in active file/WAL after close (skip byte check only for memory adapter, never semantic checks).

```bash
npm --prefix tests test -- unit/client-key-migration.test.js unit/db-migration-chain.test.js
```

Expected: PASS; latest version is 8.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/migrations/008-client-key-identity.js src/lib/db/migrations/index.js src/lib/db/migrate.js src/lib/db/schema.js tests/unit/client-key-migration.test.js tests/unit/db-migration-chain.test.js
git commit -m "feat: migrate usage to client key identity"
```

**Rollback:** failed `up` is transactional. Successful identity and verifier scrubs are intentionally forward-only and irreversible. Tested `down` yields prior-schema usage compatibility with null attribution but deliberately keeps v2 salted verifier records; it never reconstructs or weakens secrets. Operational rollback must stop the service, preserve the active DB for audit, and install a compatibility binary that understands v2 verifiers or rotate affected client keys before using an older binary. Prefer a forward fix because prior code can write raw attribution and cannot authenticate v2 records.

---

### Task 2: Policy-aware key repository and import/export

**Files:**
- Modify: `src/lib/crypto/secrets.js:78-111`
- Modify: `src/lib/db/repos/apiKeysRepo.js:1-112`
- Modify: `src/lib/db/index.js:28-31,114-212`
- Modify: `src/lib/db/migrate.js:149-200`
- Modify: `src/lib/db/migrations/008-client-key-identity.js`
- Test: `tests/unit/client-key-repo.test.js`
- Test: `tests/unit/db-sqlite-vs-lowdb.test.js`

**Interfaces:** Produces `authenticateApiKey(raw): Promise<ClientKeyRecord|null>`, `validateApiKey(raw): Promise<boolean>` for dashboard guard only, `getClientKeySpend(id): Promise<number>`, `normalizeClientKeyPatch(data)`.

- [ ] **Step 1: Write failing CRUD/auth/bounds tests**

Prove create returns full secret once/default policy; list/detail/auth never return it; legacy plaintext authenticates and upgrades; inactive rejects; policy normalization/clearing and every bound; `spentUsd` equals `COALESCE(SUM(cost),0)` by ID; old backups with absent fields remain unrestricted.

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-repo.test.js unit/db-sqlite-vs-lowdb.test.js
```

- [ ] **Step 3: Centralize matching and implement repository**

Add:

```js
export function matchesApiKeyRecord(stored, raw) {
  if (!raw || typeof raw !== "string") return false;
  const u = unpackApiKeyRecord(stored);
  return u.legacy
    ? timingSafeEqualStr(String(u.raw || ""), raw)
    : !!u.hash && timingSafeEqualStr(u.hash, hashApiKey(raw));
}
```

Use it in repo and migration. `rowToKey` parses JSON arrays and never exposes stored `key`. `authenticateApiKey` scans active rows, upgrades a matching legacy row, returns safe record plus spend. `normalizeClientKeyPatch` whitelist-validates only `name`, `isActive`, and six policy fields; unknown fields reject. Update is one transaction/fixed SQL.

- [ ] **Step 4: Preserve policies and scrub legacy imports**

Update `exportDb`, `importDb`, and `importLegacyMain` columns. Missing old fields become null. Change `importLegacyUsage` to insert `clientKeyId` and rewrite daily JSON through the migration's pure scrub/merge helper; unmatched values null.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix tests test -- unit/client-key-repo.test.js unit/db-sqlite-vs-lowdb.test.js unit/client-key-migration.test.js
git add src/lib/crypto/secrets.js src/lib/db/repos/apiKeysRepo.js src/lib/db/index.js src/lib/db/migrate.js src/lib/db/migrations/008-client-key-identity.js tests/unit/client-key-repo.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/client-key-migration.test.js
git commit -m "feat: persist bounded client key policies"
```

---

### Task 3: Cut usage/chat-core propagation to `clientKeyId`

**Files:**
- Modify: `src/lib/db/repos/usageRepo.js:82-150,281-395,407-725`
- Modify: `open-sse/handlers/chatCore.js:54-129,463-487`
- Modify: `open-sse/handlers/chatCore/requestDetail.js:77-105`
- Modify: `open-sse/handlers/chatCore/{nonStreamingHandler,sseToJsonHandler,streamingHandler}.js`
- Modify: `open-sse/utils/stream.js:32-80,549-575`
- Modify: `src/shared/components/UsageStats.js:118-175,383-400`
- Test: `tests/unit/client-key-usage.test.js`
- Test: `tests/unit/usage-request-id.test.js`
- Test: `tests/unit/cached-token-e2e.test.js`

**Interfaces:** `saveRequestUsage({...clientKeyId})`; chat-core handlers/stream callbacks accept `clientKeyId`, never gateway `apiKey`.

- [ ] **Step 1: Write failing known/local persistence tests**

Assert history, daily, `getUsageHistory`, today/all `getUsageStats` contain ID/name only and serialized values exclude raw key and `apiKeyMasked`; request ID de-duplication/cost totals remain exact.

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-usage.test.js unit/usage-request-id.test.js unit/cached-token-e2e.test.js
```

- [ ] **Step 3: Rewrite usage aggregation**

Delete `maskApiKey`; rename entry/SQL fields; persist `byClientKey`; map repository keys by `k.id`; keep outward `stats.byApiKey` only for UI, with `clientKeyId/keyName`. Preserve `pendingRequests.byAccount`, `trackPendingRequest`, ring, idempotency, and non-key stats.

- [ ] **Step 4: Rename chat-core attribution end to end**

Rename only gateway-attribution parameters in listed chat-core/stream files to `clientKeyId`; do not rename provider `credentials.apiKey`. Persist:

```js
saveRequestUsage({ provider, model, tokens: normalized, connectionId,
  clientKeyId: clientKeyId || null, endpoint, requestId });
```

Update UsageStats to render `keyName`; deleted IDs show `Deleted key (${id.slice(0,8)})`, null shows local.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix tests test -- unit/client-key-usage.test.js unit/usage-request-id.test.js unit/cached-token-e2e.test.js unit/usage-repo-hardening.test.js
git add src/lib/db/repos/usageRepo.js open-sse/handlers/chatCore.js open-sse/handlers/chatCore/requestDetail.js open-sse/handlers/chatCore/nonStreamingHandler.js open-sse/handlers/chatCore/sseToJsonHandler.js open-sse/handlers/chatCore/streamingHandler.js open-sse/utils/stream.js src/shared/components/UsageStats.js tests/unit/client-key-usage.test.js tests/unit/usage-request-id.test.js tests/unit/cached-token-e2e.test.js
git commit -m "fix: remove secrets from usage attribution"
```

---

### Task 4: Implement policy acquisition and stream-safe leases

**Files:**
- Create: `src/sse/services/clientKeyPolicy.js`
- Remove: `src/sse/utils/requireApiKeyGate.js`
- Modify: `src/sse/services/auth.js:1,320-324`
- Create: `tests/unit/client-key-policy.test.js`
- Remove: `tests/unit/require-api-key-gate.test.js`

**Interfaces:** Produces the exact policy service contract above; consumes `authenticateApiKey`, `getClientKeySpend`, `isLocalRequest`, `hasValidCliToken`.

- [ ] **Step 1: Write failing policy matrix and cleanup tests**

Use fake clock/mocks. Cover bypass/missing/invalid, expiration equality, unrestricted defaults, model/combo allow/deny, spend below/equal/above, rate N/N+1/window rollover/Retry-After, concurrency N/N+1, per-key isolation, and reset. Assert no secret/config values in errors.

Test non-stream success, throw, SSE EOF, SSE source error, and consumer cancellation. Release must be delayed for SSE and called exactly once; wrapped response status/statusText/headers/bytes remain identical.

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-policy.test.js
```

- [ ] **Step 3: Implement process-local state and errors**

```js
if (!global._clientKeyPolicyState) global._clientKeyPolicyState = { byId: new Map() };
```

Entries are `{windowStartedAt,acceptedStarts,inFlight}`. After awaited spend query, checks/increments are synchronous. Lease captures ID and `released`. Use generic OpenAI-compatible policy response and exact order above.

- [ ] **Step 4: Implement response wrapper**

Non-SSE/bodyless releases before return. SSE uses a source reader and new `ReadableStream`: `pull` forwards and releases on done/error; `cancel(reason)` releases and awaits source cancel. Work rejection releases/rethrows.

- [ ] **Step 5: Remove old convention and verify**

Delete old gate/test and `isValidApiKey` service wrapper; dashboard guard retains repo boolean validation.

```bash
npm --prefix tests test -- unit/client-key-policy.test.js unit/dashboard-guard.test.js
git add src/sse/services/clientKeyPolicy.js src/sse/services/auth.js src/sse/utils/requireApiKeyGate.js tests/unit/client-key-policy.test.js tests/unit/require-api-key-gate.test.js
git commit -m "feat: enforce bounded client key policies"
```

---

### Task 5: Gate every provider-work handler once

**Files:**
- Modify: `src/sse/handlers/{chat,embeddings,fetch,imageGeneration,search,stt,tts}.js`
- Modify: `src/app/api/v1beta/models/[...path]/route.js:180-195,237-320`
- Create: `tests/unit/client-key-handler-gates.test.js`
- Modify: `tests/unit/non-chat-abort.test.js`
- Modify: `tests/unit/gemini-native-endpoint.test.js`

**Interfaces:** Consumes policy service; authorized private closures receive `clientKeyId` and pre-resolved combo data, never raw key.

- [ ] **Step 1: Write failing handler-boundary tests**

For all eight surfaces assert policy rejection returns unchanged and never calls combo rotation/model routing/credentials/fetch. Assert target classification. For non-stream and chat SSE assert release on success, throw, abort, EOF, cancel.

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-handler-gates.test.js unit/non-chat-abort.test.js unit/gemini-native-endpoint.test.js
```

- [ ] **Step 3: Refactor to one authorization boundary**

Each handler follows:

```js
const auth = await authorizeClientKeyRequest({ settings, rawKey: extractApiKey(request),
  request, target: { kind: comboModels ? "combo" : "model", id: requestedId } });
if (!auth.ok) return auth.response;
return runWithClientKeyLease(auth.lease, () =>
  handleAuthorizedRequest({ body, request, clientKeyId: auth.clientKeyId, comboModels }));
```

Move every post-auth early return into the private closure and reuse combo lookup. No provider work precedes acquire.

- [ ] **Step 4: Remove raw identity from chat/Gemini**

Chat passes ID to `handleSingleModelChat`/chat core. Feedback/vault use `hashKey(clientKeyId || "local-no-key")`. Delete masked raw-key debug logging. Replace Gemini's separate validator with policy authorization around native provider work.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix tests test -- unit/client-key-handler-gates.test.js unit/non-chat-abort.test.js unit/gemini-native-endpoint.test.js unit/claude-handler-credential-isolation.test.js unit/responses-abort-terminal.test.js unit/responses-handler-streaming.test.js
git add src/sse/handlers src/app/api/v1beta/models/[...path]/route.js tests/unit/client-key-handler-gates.test.js tests/unit/non-chat-abort.test.js tests/unit/gemini-native-endpoint.test.js
git commit -m "feat: gate provider work by client key policy"
```

---

### Task 6: Strict key API and editable policy UI

**Files:**
- Modify: `src/app/api/keys/route.js:8-42`
- Modify: `src/app/api/keys/[id]/route.js:5-58`
- Modify: `src/lib/dashboard/loaders.js:53-68`
- Modify: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js:15-383`
- Create: `src/app/(dashboard)/dashboard/endpoint/components/KeyPolicyModal.js`
- Create: `tests/unit/client-key-routes.test.js`
- Create: `tests/unit/client-key-ui.test.js`

**Interfaces:** List/detail return safe `ClientKeyRecord`; POST returns full secret once; PUT accepts only `name,isActive,allowedModels,allowedCombos,expiresAt,rateLimitPerMinute,concurrencyLimit,spendLimitUsd`.

- [ ] **Step 1: Write failing route/UI tests**

Route tests prove safe list/detail, one-time POST secret, full PUT, explicit null clearing, omitted-field preservation, 400 for invalid/unknown fields without update call, 404/500 behavior. Following existing source-contract convention (no DOM dependency), UI test proves Edit modal wiring/exact PUT fields/current spend and no reveal/copy action for listed prefix; creation modal retains one-time copy.

- [ ] **Step 2: Verify red**

```bash
npm --prefix tests test -- unit/client-key-routes.test.js unit/client-key-ui.test.js
```

- [ ] **Step 3: Implement strict routes**

Preserve property presence when normalizing patches; do not turn omitted into null. Invalid input returns 400 `{error:{message,code:"invalid_client_key_policy"}}`; never log body.

- [ ] **Step 4: Build focused modal and wire UI**

`KeyPolicyModal` props: `apiKey,isOpen,isSaving,onClose,onSave`. Edit name; newline exact model IDs; newline combo names; datetime-local expiry; integer rate/concurrency; dollar ceiling; display `spentUsd` read-only. Empty controls serialize arrays/null; numbers serialize as numbers. Server remains authoritative.

Remove `visibleKeys`, reveal, and copy from listed keys; display `keyPrefix`. Add Edit and policy summary chips; mutation PUT invalidates `queryKeys.endpoint.keys()`. Keep pause/delete/require-key/creation behavior.

- [ ] **Step 5: Verify and commit**

```bash
npm --prefix tests test -- unit/client-key-routes.test.js unit/client-key-ui.test.js unit/dashboard-polish.test.js
git add src/app/api/keys src/lib/dashboard/loaders.js src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js src/app/(dashboard)/dashboard/endpoint/components/KeyPolicyModal.js tests/unit/client-key-routes.test.js tests/unit/client-key-ui.test.js
git commit -m "feat: manage client key policies"
```

---

### Task 7: Security regression—no reusable key in SQLite, logs, or metrics

**Files:**
- Modify: `open-sse/config/appConstants.js:75-88`
- Modify: `tests/unit/request-logger-redaction.test.js`
- Create: `tests/unit/client-key-security-regression.test.js`
- Modify: `src/lib/db/repos/requestDetailsRepo.js:62-110` only if a tested gateway carrier is missing.

**Interfaces:** Proves the final cross-layer invariant. Prometheus remains separately owned and must consume this no-key-dimension contract.

- [ ] **Step 1: Write full-redaction regression**

```js
for (const h of ["authorization","x-switchboard-key","x-api-key","x-goog-api-key"]) {
  const out = maskSensitiveHeaders({ [h]: RAW_KEY });
  expect(out[h]).toBe("[redacted]");
  expect(JSON.stringify(out)).not.toContain(RAW_KEY);
}
```

Move `x-api-key` and `x-goog-api-key` to `FULL_REDACTION_REQUEST_LOG_HEADER_NAMES`.

- [ ] **Step 2: Write end-to-end secret non-propagation test**

Create real key, execute mocked non-stream and consumed/cancelled stream requests, then serialize `usageHistory`, `usageDaily`, `requestDetails`, `getUsageHistory`, and today/all `getUsageStats`. Assert neither full key nor trailing 12-character secret segment appears; assert aggregate payload has no raw/masked/prefix field. Spy console across invalid/expired/allowlist/rate/concurrency/spend failures and inspect enabled request-log files with same assertions.

Close/checkpoint file adapter and scan active DB/WAL bytes for full/trailing secret. The `apiKeys.key` row may contain only packed prefix/hash. For memory adapter skip only byte scan.

`getUsageStats` is this task's aggregate metrics boundary. Separate Prometheus tests must also assert `/metrics` has no key ID/name/prefix labels.

- [ ] **Step 3: Verify focused security suite**

```bash
npm --prefix tests test -- unit/request-logger-redaction.test.js unit/client-key-security-regression.test.js
```

Expected before full redaction: FAIL for partially masked alternate headers; after: PASS.

- [ ] **Step 4: Run affected suite, full suite, and build**

```bash
npm --prefix tests test -- unit/client-key-migration.test.js unit/client-key-repo.test.js unit/client-key-usage.test.js unit/client-key-policy.test.js unit/client-key-handler-gates.test.js unit/client-key-routes.test.js unit/client-key-ui.test.js unit/client-key-security-regression.test.js unit/dashboard-guard.test.js unit/db-migration-chain.test.js unit/db-sqlite-vs-lowdb.test.js unit/usage-request-id.test.js unit/request-logger-redaction.test.js unit/non-chat-abort.test.js unit/responses-abort-terminal.test.js unit/gemini-native-endpoint.test.js
npm --prefix tests test
npm run build
```

Expected: all new tests pass with no new expected failures/skips; existing baseline was 256 files passed/13 skipped, 2200 tests passed/13 expected fail/61 skipped. Production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add open-sse/config/appConstants.js tests/unit/request-logger-redaction.test.js tests/unit/client-key-security-regression.test.js src/lib/db/repos/requestDetailsRepo.js
git commit -m "test: prove gateway keys never reach telemetry"
```

---

## Integration Contract and Non-Goals

Land this plan first. Scheduler then adds its read-only connection in-flight accessor while retaining `clientKeyId`/`byClientKey`. Telemetry consumes aggregate repositories without key dimensions. Resolve overlap in `usageRepo.js` by preserving both contracts.

No wildcard/regex allowlists, token bucket, endpoint allowlist, per-key provider/account scheduling, cost estimation/reservation, key rotation, distributed counters, billing, or new management API family. Existing `/api/keys` remains the sole key-management surface.
