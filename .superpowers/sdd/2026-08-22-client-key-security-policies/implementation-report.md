# Client-Key Security and Bounded Policies — Implementation Report

## Result

Implemented Tasks 1–7 on `feat/gateway-priorities` in the ordered plan boundaries. Gateway request attribution now uses stable `apiKeys.id` values; raw gateway keys are accepted only for authentication and one-time creation display. Persisted policies cover exact model/combo allowlists, expiration, fixed-window request rate, concurrent in-flight requests, and already-spent USD ceilings.

The final affected suite passed: **21 files, 133 tests, 0 failures**. Per the assignment, no project-wide test suite, lint, production build, scheduler work, or Prometheus implementation was run.

## Task 1 — Migration 8

### Files

- `src/lib/db/migrations/008-client-key-identity.js`
- `src/lib/db/migrations/index.js`
- `src/lib/db/migrate.js`
- `src/lib/db/schema.js`
- `tests/unit/client-key-migration.test.js`
- `tests/unit/db-migration-chain.test.js`

### Interfaces and behavior

- Added migration `{ version: 8, name: "client-key-identity", up, down, afterUp }`.
- Added nullable key-policy columns to `apiKeys`.
- Rebuilt `usageHistory` with `clientKeyId TEXT` and no `apiKey` column or foreign key.
- Recreated timestamp/provider/model/connection/client-key/request-ID indexes; request IDs remain uniquely indexed when present.
- Rewrote and merged `usageDaily.data.byApiKey` into secret-free `byClientKey` counters.
- Known packed and legacy plaintext keys map to stable IDs; local and unmatched historical values map to `NULL`.
- Legacy plaintext key rows are packed after resolution so the scrubbed database no longer contains reusable key bytes.
- `down()` restores the version-7 shape with null attribution without reconstructing secrets.
- `afterUp()` checkpoints, vacuums with secure deletion enabled, and checkpoints again.
- Migration runner now commits `up`, runs `afterUp`, and only then stamps the version. An `afterUp` failure leaves version 7 and the idempotent `up` safely retries.

### TDD evidence

- RED: `client-key-migration.test.js` initially failed because migration 8 did not exist; the runner retry test then failed because `runVersionedMigrations` was not exported/using post-commit `afterUp` semantics.
- GREEN: migration and chain suite passed **8 tests**.
- Round-trip fixture preserved row count, explicit IDs, request IDs, prompt/completion totals, cost totals, non-key daily breakdowns, and autoincrement behavior. Closed database/WAL byte scans excluded all seeded reusable secrets.

## Task 2 — Policy-aware key repository and import/export

### Files

- `src/lib/crypto/secrets.js`
- `src/lib/db/repos/apiKeysRepo.js`
- `src/lib/db/index.js`
- `src/lib/db/migrate.js`
- `src/lib/db/migrations/008-client-key-identity.js`
- `tests/unit/client-key-repo.test.js`
- `tests/unit/db-sqlite-vs-lowdb.test.js`

### Interfaces

- `CLIENT_KEY_POLICY_BOUNDS`
- `matchesApiKeyRecord(stored, raw)`
- `authenticateApiKey(raw): Promise<ClientKeyRecord|null>`
- `validateApiKey(raw): Promise<boolean>`
- `getClientKeySpend(id): Promise<number>`
- `normalizeClientKeyPatch(data)`

### Behavior

- `createApiKey` returns the generated secret once. List, detail, update, and authentication records expose only `keyPrefix` and safe policy fields.
- Legacy plaintext authentication upgrades the stored row; inactive keys do not authenticate.
- Allowlist values are trimmed, order-preserving, de-duplicated, and bounded. Expiration and numeric policy bounds follow the locked contract.
- Updates accept only `name`, `isActive`, and the six policy fields, preserve omitted fields, and clear explicit null/empty values.
- `spentUsd` comes from persisted `usageHistory.cost` by stable key ID.
- Database and legacy imports preserve policy values, default absent old-backup values to unrestricted, hash plaintext imported keys, and scrub legacy usage attribution.

### TDD evidence

- RED: repository tests failed on missing safe defaults, authentication, normalization, and spend interfaces.
- GREEN: repository suite passed **5 tests**; focused import/export/migration cases passed **11 tests** with unrelated parity cases filtered until Task 3 completed the destructive identity cutover.

## Task 3 — Usage and chat-core identity cutover

### Files

- `src/lib/db/repos/usageRepo.js`
- `open-sse/handlers/chatCore.js`
- `open-sse/handlers/chatCore/requestDetail.js`
- `open-sse/handlers/chatCore/nonStreamingHandler.js`
- `open-sse/handlers/chatCore/sseToJsonHandler.js`
- `open-sse/handlers/chatCore/streamingHandler.js`
- `open-sse/utils/stream.js`
- `open-sse/utils/usageTracking.js`
- `tests/unit/client-key-usage.test.js`

### Behavior

- `saveRequestUsage` and all chat/stream callbacks use `clientKeyId`; provider `credentials.apiKey` remains unchanged.
- Daily data writes `byClientKey`; public `stats.byApiKey` retains its product-facing name but contains only `clientKeyId`, `keyName`, and usage fields.
- Deleted IDs render as `Deleted key (<first 8>)`; null attribution renders as local/no-key.
- Request history returns `clientKeyId` and never masked/raw key fields.
- Request-ID idempotency, cached-token accounting, cost totals, pending-account tracking, and non-key aggregations remain intact.

### TDD evidence

- RED: the destructive schema cutover exposed every stale `apiKey` insert/select and caused usage/cached-token/request-ID tests to fail.
- GREEN: usage repository, request-ID, cached-token, parity, and hardening coverage passed; the Task 3 focused verification passed **14 tests** plus the complete parity file.

## Task 4 — Policy service and leases

### Files

- Added `src/sse/services/clientKeyPolicy.js`
- Removed `src/sse/utils/requireApiKeyGate.js`
- Updated `src/sse/services/auth.js`
- Added `tests/unit/client-key-policy.test.js`
- Removed `tests/unit/require-api-key-gate.test.js`

### Interfaces

- `authorizeClientKeyRequest({ settings, rawKey, request, target })`
- `runWithClientKeyLease(lease, work)`
- `__resetClientKeyPolicyStateForTests()`

### Behavior

- Enforces the exact bypass/auth/expiration/target/spend/concurrency/rate order.
- Uses per-key, process-local fixed 60-second rate windows and in-flight counts.
- Checks persisted spend before synchronous acquisition; one accepted request may cross a spend ceiling.
- Returns generic OpenAI-compatible policy errors without secret, prefix, name, current spend, or configured limits.
- Leases are idempotent and clamp in-flight counts at zero.
- Non-SSE and thrown work release immediately/exactly once. SSE release is delayed until EOF, source error, or consumer cancellation; cancellation also cancels the source reader while preserving response status, status text, headers, and bytes.

### TDD evidence

- RED: policy module import failed because the service did not exist.
- GREEN: **11 policy tests** passed across bypass, missing/invalid, expiration equality, allowlists, spend equality, rate rollover/retry, concurrency/isolation/reset, non-stream success/throw, SSE EOF/error/cancel.

## Task 5 — Provider-work gates

### Files

- `src/sse/handlers/{chat,embeddings,fetch,imageGeneration,search,stt,tts}.js`
- `src/app/api/v1beta/models/[...path]/route.js`
- `tests/unit/client-key-handler-gates.test.js`
- `tests/unit/gemini-native-endpoint.test.js`
- `tests/unit/claude-handler-credential-isolation.test.js`

### Behavior

- All eight provider-work surfaces use one authorization boundary and one lease boundary.
- Combo-capable routes resolve combo classification before acquisition and reuse it; model-only routes classify directly. Gemini native uses `gemini/${normalizeGeminiNativeModel(model)}`.
- Behavioral rejection coverage proves unchanged policy responses return before model routing, credentials, lease work, or fetch across all eight surfaces.
- Chat threads only `clientKeyId`; feedback/vault scopes hash `clientKeyId || "local-no-key"`.
- Chat removes gateway-key carriers from copied client headers before request logging/provider runtime propagation.
- No masked raw gateway key debug logging remains.

### TDD evidence

- RED: all eight source/boundary tests failed on the old gate and raw-key propagation.
- GREEN: provider gate, abort, Gemini native, Claude credential isolation, and Responses streaming/terminal suite passed **28 tests**.

## Task 6 — Strict API and policy UI

### Files

- `src/app/api/keys/route.js`
- `src/app/api/keys/[id]/route.js`
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`
- Added `src/app/(dashboard)/dashboard/endpoint/components/KeyPolicyModal.js`
- `tests/unit/client-key-routes.test.js`
- `tests/unit/client-key-ui.test.js`

### Behavior

- List/detail responses are safe records; POST returns the full secret once.
- PUT normalizes the strict field whitelist, preserves omission, supports explicit clearing, returns `invalid_client_key_policy` with HTTP 400, and never logs request bodies.
- Listed rows show only `keyPrefix`; reveal/copy actions for existing keys were removed. One-time creation copy remains.
- Edit modal supports active/name, exact model/combo lines, local datetime expiration, integer rate/concurrency, USD ceiling, and read-only current spend.
- Successful edits invalidate `queryKeys.endpoint.keys()`; existing pause/delete/require-key/create behavior remains.

### TDD and runtime evidence

- RED: route normalization and every UI source contract failed before implementation.
- GREEN: route/UI/dashboard-polish suite passed **12 tests**.
- Runtime smoke: the actual Next development surface loaded at `/dashboard/endpoint`; the API-key card and creation modal rendered with live controls. The generic Next dev server rejected mutating `/api/keys` requests as `403 Local only` because it lacks the custom server's socket-derived locality headers, so the edit-save browser round-trip could not be exercised in that runtime. Route behavior and modal wiring remain covered by focused tests.

## Task 7 — Cross-layer security regression

### Files

- `open-sse/config/appConstants.js`
- `tests/unit/request-logger-redaction.test.js`
- `tests/unit/client-key-security-regression.test.js`

### Behavior and evidence

- `authorization`, `x-switchboard-key`, `x-api-key`, and `x-goog-api-key` are fully redacted in request logs.
- Real key creation plus usage/detail persistence proves full key and trailing 12-character secret material are absent from history, daily data, request details, history API, today/all aggregates, active SQLite, and WAL bytes.
- Aggregate key entries contain no raw, masked, prefix, or reusable-key dimensions.
- RED: alternate key carriers were partially masked (`sk-switc...cret`).
- GREEN: focused security suite passed **3 tests**.

## Commits

1. `5abef1e7 feat: migrate usage to client key identity`
2. `04472a38 feat: persist bounded client key policies`
3. `871da79f fix: remove secrets from usage attribution`
4. `0f40a9db feat: enforce bounded client key policies`
5. `8db504c6 feat: gate provider work by client key policy`
6. `3ac0ff54 feat: manage client key policies`
7. `db8bb7ea test: prove gateway keys never reach telemetry`

## Final verification

Command: the plan's affected client-key suite plus cached-token, usage-hardening, Claude isolation, Responses streaming, and dashboard-polish regressions.

Result: **21 test files passed; 133 tests passed; 0 failures**.

Not run by explicit assignment constraint: project-wide tests, lint, React Doctor (lint-equivalent scan), production build, scheduler tests, Prometheus tests.

## Self-review and concerns

- Reviewed all seven commit boundaries and ran `git diff --check`; the only issue found was an extra EOF blank line in `src/sse/services/auth.js`, removed before finalization.
- No scheduler or Prometheus implementation files were changed.
- The workstation's `better-sqlite3` native binding is unavailable under Node 26.7.0. Database tests transparently used the repository's `node:sqlite` adapter; semantic migration checks and closed-file/WAL byte scans still ran.
- Migration 8's scrub is intentionally irreversible. `down()` provides prior-schema compatibility with null attribution, not reconstructed secrets; a forward fix remains the preferred operational rollback.
- Rate and concurrency counters are intentionally process-local and reset on restart; spend remains persisted.
