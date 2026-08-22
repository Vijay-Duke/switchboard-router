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

## Review fix round 1

Blocking findings from `review-findings-round1.md` were addressed in commit:

- `8ac7146c fix: close client key security review gaps`

### Fixes

1. **Safe list consumers:** migrated dashboard CLI/MITM cards, internal model probes, Claude picker labels, application MITM startup, and CLI setup flows away from `ClientKeyRecord.key`. Listed records render `keyPrefix` metadata only. Tool setup now requires a password-style explicitly supplied secret; internal probes use the CLI-token bypass. Protected MITM auto-start now refuses to invent/reuse a listed secret.
2. **Usage completion ordering:** `saveUsageStats` returns the persistence promise; non-stream and forced-SSE-to-JSON handlers await it. Stream completion callbacks and transform flushes are async/awaited, so a completed request's durable spend is visible before EOF.
3. **Production migration retry:** `_migratedAdapters` is marked only after successful completion. A failed `afterUp` now retries through `runMigrationOnce` on the same adapter.
4. **Runtime/log security paths:** all eight real handler rejection surfaces execute with a reusable test key while console output is checked for full/tail absence. Enabled request-log files are inspected for every gateway carrier. Existing non-stream, consumed-stream, cancelled-stream, source-error, and thrown-work lease tests remain green.
5. **Matched-key spend lookup:** authentication scans active verifier records without spend joins, then issues exactly one durable spend lookup for the matched ID.
6. **Pruning-safe spend ledger:** added monotonic `apiKeys.spentUsd`, seeded by migration 8 and incremented in the same idempotent transaction as accepted usage. History pruning no longer lowers spend. Backup/import preserves the ledger; authorization reads it.
7. **Embeddings/STT aborts:** request abort signals now reach initial/retry embedding fetches and every STT upload/submit/poll fetch plus polling delay. Focused tests prove active upstream cancellation and exactly-once lease release.
8. **Legacy source sanitization:** successful import checkpoints, atomically rewrites original and migration-backup `db.json`/`usage.json`, removes plaintext usage attribution, replaces key secrets with verifier records, applies mode `0600`, and supports sanitizer retry before marker creation.
9. **Slow salted verifier:** new keys and plaintext migrations use versioned `v2:<prefix>:<salt>:<scrypt>` records. Authentication keeps constant-time v1/legacy compatibility and upgrades matched v1/plaintext rows to v2.

### Red/green evidence

- RED command: migration entry, repository/ledger/verifier, STT abort, safe consumers, and usage-completion tests.
- RED result: **5 files failed with 9 expected contract failures** (same-adapter migration retry, v2 verifier, durable spend, STT signal, list consumers, awaited usage/stream completion).
- GREEN command 1: the same focused review tests plus embeddings abort, migration chain, and all handler rejection paths.
- GREEN result 1: **9 files passed; 38 tests passed**.
- GREEN command 2: migration/repository/usage/policy/handler/security/log-file/abort/consumer/completion/parity/cached-token/request-ID/Responses focused suite.
- GREEN result 2: **17 files passed; 84 tests passed**.
- Consumer regression command: initialize lifecycle, model/provider probes, CLI route writes, and dashboard polish.
- Consumer result: **5 files passed; 42 tests passed**.

No full suite, lint, React Doctor, build, scheduler, or Prometheus command was run.

Final round-1 verification after both commits: **29 focused files passed; 180 tests passed; 0 failures**. This included every original client-key contract plus new verifier, durable-ledger/pruning, migration retry/sanitization, enabled log-file, all-handler rejection, usage-completion ordering, embeddings/STT abort, safe-consumer, application lifecycle, probe, CLI route, and dashboard regressions.

## Review fix round 2

Commit `f01f4f84 fix: harden client key rollback and runtime` addresses the merged round-2 findings:

- CLI terminal/key menus display `keyPrefix` only; creation remains the sole one-time secret output. CLI tool setup uses a masked `promptSecret` path with a behavioral non-echo regression.
- Historical legacy JSON costs increment `apiKeys.spentUsd` inside the import transaction.
- Legacy source sanitization uses the independent `.legacy-secrets-sanitized` marker and requires durable `_meta.migratedAt` proof, so old successful imports are scrubbed while failed imports retain rollback sources.
- `keyPrefix` is stored/indexed as a non-secret lookup discriminator. Authentication selects at most eight matching/legacy candidates, normally performs zero KDFs for arbitrary invalid keys, and verifies v2 candidates with asynchronous `crypto.scrypt`; synchronous scrypt remains migration/creation-only.
- Embeddings/STT preserve abort as status 499, abort already-cancelled polling delays immediately, and handlers return before account fallback/rotation.
- Migration/operator rollback documentation now states the verifier transition is forward-only: use a v2-compatible binary or rotate keys. `down()` explicitly proves v2 records remain non-reconstructed/non-weakened.
- A behavioral authorization test proves awaited completed usage is visible to the immediately following spend check.
- The prior real handler rejection, console, enabled log-file, request-detail, repository, DB/WAL, streaming EOF/error/cancel, and non-stream security coverage remains green.

Round-2 focused verification:

- First focused pass: **11 files, 51 tests, 0 failures**.
- Expanded regression pass: **17 files, 85 tests, 0 failures**.
- No full suite, lint, React Doctor, build, scheduler, or Prometheus command was run.

## Review fix round 3

Commit `5cc3a91f fix: use unique client key lookups` completes the lookup and remaining consumer corrections:

- Media embedding/generic/STT/TTS and combo examples no longer hydrate secrets from `/api/keys`; execution stays disabled until a raw secret is pasted.
- Generated-key lookup uses the embedded random key-ID segment, persisted in indexed nullable `lookupId`. New v2 records embed the lookup ID; production selects one v2 candidate and performs one asynchronous scrypt. Legacy/v1 fallback uses cheap matching only and upgrades when a parseable lookup exists. Missing-lookup v2 records remain explicitly rotation-required.
- Non-TTY secret prompting now rejects with a clear message and reads/echoes no input; TTY masking remains behaviorally covered.
- Historical import spend, sanitizer proof state, 499 abort handling, forward-only rollback, and behavioral completion-to-next-spend ordering remain green.

Round-3 focused verification:

- Lookup/repository/usage/parity pass: **3 files, 35 tests, 0 failures**.
- Migration/consumer/prompt/abort/handler/policy/security pass: **10 files, 42 tests, 0 failures**.
- No full suite, lint, React Doctor, build, scheduler, or Prometheus command was run.

## Review fix round 4

Commits:

1. `28657416 fix: digest client key lookups`
2. `cd1a80be test: prove client key runtime boundaries`

### Production changes

- Generated-key lookup now persists and indexes only `lookupDigest = SHA-256("sb-key-lookup:" + keyId)`. The raw 128-bit key-ID segment is absent from the packed verifier, schema column, export/import payload, active database, and WAL.
- A modern request performs one unique indexed digest lookup and one asynchronous scrypt verification. The repository regression authenticates 12 same-machine keys, checks one digest query/one async scrypt for selected keys beyond the former eight-row cap, and proves an unknown valid modern key performs zero KDFs.
- Plaintext/v1 records with a parseable modern key ID upgrade to v2 plus a digest. Unparseable plaintext upgrades only to the existing cheap v1 hash; unparseable v1 remains unchanged and authenticatable. Both return `rotationRequired: true`. Missing-lookup v2 remains rotation-required and unusable and is excluded from fallback scans.
- List/detail/authentication records expose `rotationRequired` but no verifier or digest metadata. The endpoint key-management card shows a safe “Rotation required” status and explains that the compatibility verifier remains usable until replacement.
- Migration 8, full DB import/export, and legacy JSON import use `lookupDigest`; old v2 records containing a 32-hex raw lookup segment are normalized to its domain-separated digest without recomputing the scrypt verifier.
- The NVIDIA real translator test no longer reads `.key` from `getApiKeys`; it requires the explicitly supplied `NV_E2E_KEY`. Consumer regression coverage names repository, CLI, dashboard, media, and real-test boundaries.

### Behavioral proof

- `tests/unit/client-key-real-handler-security.test.js` crosses the real public `handleChat`, real `authorizeClientKeyRequest`, real lease wrapper, real chat-core non-stream/SSE completion, and real SQLite repositories. Only provider execution/account selection are local seams.
- Non-stream and fully consumed SSE each cross a $1 ceiling with a persisted $7 completion, then immediately re-authorize and receive `client_key_spend_limit_exceeded`.
- The same actual-handler harness covers successful non-stream, fully consumed SSE, cancelled SSE, and invalid/expired/model-allowlist/combo-allowlist/rate/concurrency/spend rejection. After each group it inspects console calls, enabled request-log files, request details, history, daily/public aggregates, active SQLite, and WAL bytes for both the full secret and its trailing 12 characters.
- `tests/unit/client-key-real-abort.test.js` drives the real embeddings and STT public handlers through real policy acquisition at `concurrencyLimit=1`. A stalled abortable core seam observes cancellation, returns 499 before account unavailability/fallback, releases the lease, and admits the immediate next request. `non-chat-abort.test.js` additionally proves an already-aborted AssemblyAI polling delay returns 499 without a poll or two-second wait.
- `db-migration-chain.test.js` now proves a row-count import failure rolls back earlier rows/settings, preserves exact original and migration-backup bytes, and writes neither migration nor sanitizer marker; a schema-stamped database without durable `migratedAt` also leaves originals/backups untouched. An old `.migrated-from-json` plus durable `migratedAt` and missing sanitizer marker sanitizes both the source and old migration backup exactly through the proof-gated restart path.
- The source-text-only completion test was removed; completion/spend order is now checked only through public runtime behavior.

### Exact files

Production:

- `src/lib/crypto/secrets.js`
- `src/lib/db/schema.js`
- `src/lib/db/migrations/008-client-key-identity.js`
- `src/lib/db/repos/apiKeysRepo.js`
- `src/lib/db/index.js`
- `src/lib/db/migrate.js`
- `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js`
- `tests/translator/real/nvidia-thinking.e2e.test.js`

Tests:

- `tests/unit/client-key-repo.test.js`
- `tests/unit/client-key-migration.test.js`
- `tests/unit/db-migration-chain.test.js`
- `tests/unit/client-key-usage.test.js`
- `tests/unit/client-key-consumers.test.js`
- `tests/unit/client-key-ui.test.js`
- `tests/unit/client-key-real-handler-security.test.js`
- `tests/unit/client-key-real-abort.test.js`
- `tests/unit/non-chat-abort.test.js`
- removed `tests/unit/client-key-usage-completion.test.js`

### Red/green commands and results

- RED: `npm --prefix tests test -- unit/client-key-repo.test.js unit/client-key-migration.test.js unit/client-key-consumers.test.js unit/client-key-ui.test.js`
  - Result before production edits: **4 files failed, 8 contract failures**. Missing `lookupDigest`, raw lookup-ID queries, legacy rotation status, safe UI status, and final real-test consumer all failed as expected.
- First lookup GREEN: the same command.
  - Result: **4 files passed, 22 tests passed, 0 failures**.
- Migration failure-state proof: `npm --prefix tests test -- unit/db-migration-chain.test.js`
  - Result: **1 file passed, 7 tests passed, 0 failures**. These were proof gaps rather than production defects, so the new failure/rollback/crash cases passed on their first behavioral run.
- Real abort/lease proof: `npm --prefix tests test -- unit/client-key-real-abort.test.js unit/non-chat-abort.test.js`
  - Result: **2 files passed, 6 tests passed, 0 failures**. The new public-handler proof passed on its first run; the underlying abort/lease implementation was already correct.
- Real handler secrecy and completion proof: `npm --prefix tests test -- unit/client-key-real-handler-security.test.js`
  - Result: **1 file passed, 4 tests passed, 0 failures**. The runtime behavior was already correct; this replaced the inadequate source-text completion proof.
- Expanded focused regression: `npm --prefix tests test -- unit/client-key-repo.test.js unit/client-key-migration.test.js unit/db-migration-chain.test.js unit/db-sqlite-vs-lowdb.test.js unit/client-key-usage.test.js unit/client-key-policy.test.js unit/client-key-routes.test.js unit/client-key-ui.test.js unit/client-key-security-regression.test.js unit/client-key-handler-gates.test.js unit/client-key-real-handler-security.test.js unit/client-key-real-abort.test.js unit/non-chat-abort.test.js unit/request-logger-redaction.test.js unit/request-logger-file-security.test.js unit/client-key-consumers.test.js`
  - Result: **16 files passed, 97 tests passed, 0 failures**.
- Post-review focused recheck: `npm --prefix tests test -- unit/client-key-repo.test.js unit/client-key-migration.test.js unit/db-migration-chain.test.js unit/client-key-real-handler-security.test.js unit/client-key-real-abort.test.js unit/non-chat-abort.test.js`
  - Result: **6 files passed, 32 tests passed, 0 failures**.

- Final committed focused verification: the expanded focused regression command above.
  - Result: **16 files passed, 98 tests passed, 0 failures** after adding the explicit missing-lookup v2 unusable/rotation-required case.

### Concerns and scope

- `better-sqlite3` is unavailable for Node 26.7.0 on this workstation; all database proofs ran against the repository’s real `node:sqlite` adapter, including active SQLite/WAL byte scans.
- Proof-only round-4 additions for migration failure states, real abort leases, and completion ordering passed on their first run because the corresponding production behavior was already correct; the report does not mislabel those runs as red.
- No full suite, build, lint, formatter, scheduler, Prometheus, push, or merge command was run.

## Review fix round 5

Commit `8fe0896b fix: close final client key security gaps` addresses every
item in `review-findings-round5.md`:

- The policy lease exposes a test-only release observer at its idempotent
  release boundary. Real embeddings and STT abort tests observe one effective
  release, invoke the same lease's cleanup again, cancel the returned body,
  and prove the count remains one before the immediate next request is
  admitted.
- The successful old-marker plus durable-proof sanitizer test now performs a
  second production restart and proves the original and migration-backup
  `db.json`/`usage.json` bytes and nanosecond mtimes remain unchanged once the
  dedicated sanitizer marker exists.
- Legacy authentication derives `apiKeyPrefix(raw)` and queries only active,
  lookup-less, non-v2 rows whose indexed `keyPrefix` matches. The regression
  seeds 64 unrelated-prefix rows with otherwise matching verifier hashes and
  proves only the intended unparseable legacy row authenticates with
  `rotationRequired: true`.
- `docs/ARCHITECTURE.md` states the compatibility-verifier rotation status,
  missing-lookup v2 rotation requirement, forward-only transition, and older
  binary incompatibility.

### Red/green evidence

- RED:
  `npm --prefix tests test -- unit/client-key-real-abort.test.js unit/db-migration-chain.test.js unit/client-key-repo.test.js`
  - Result: **2 files failed, 1 passed; 3 expected failures**. Both real abort
    cases lacked the release observer, and the broad legacy scan authenticated
    the first unrelated row. The sanitizer second-restart proof passed on its
    first run because marker-gated runtime behavior was already correct.
- Focused GREEN: the same command.
  - Result: **3 files passed; 20 tests passed; 0 failures**.
- Expanded affected regression:
  `npm --prefix tests test -- unit/client-key-repo.test.js unit/client-key-migration.test.js unit/db-migration-chain.test.js unit/client-key-policy.test.js unit/client-key-real-handler-security.test.js unit/client-key-real-abort.test.js unit/non-chat-abort.test.js`
  - Result: **7 files passed; 44 tests passed; 0 failures**.

### Self-review and scope

- Reviewed the six-file implementation/test/operator-doc diff after green;
  no correctness, security, or unrelated-scope issue remained.
- Preserved digest lookup, asynchronous scrypt, legacy usability and rotation
  status, policy gates, spend accounting, abort behavior, sanitization, and
  secrecy coverage.
- No full suite, build, lint, formatter, scheduler, Prometheus, push, or merge
  command was run.

## Final migration blocker wave

Commit `9ce31f7b fix: make legacy import retryable` resolves the final two whole-branch blockers:

- Pending legacy import is now derived from `hasLegacy && !alreadyImported && !migrationProof`, independent of one-boot freshness. Import proceeds only when every target table is empty. A first-start row-count rollback preserves exact source/backup bytes and markers; after repairing the source, the same schema-9 database imports successfully on the second start, writes durable `migratedAt`, rebuilds spend/metrics, sanitizes sources, and writes markers. A proofless crash with non-empty targets remains fail-closed and non-destructive.
- A process-memory raw legacy key → client-key ID map is built from legacy main data before verifier packing. History and daily import use the map, so no raw key is persisted and no verifier KDF runs per usage row. A 250-row regression proves full attribution/spend preservation with at most the one-time key-packing KDF cost.

Focused command: `npm --prefix tests test -- unit/db-migration-chain.test.js unit/client-key-migration.test.js`

Result: **2 files passed; 13 tests passed; 0 failures**.

No full suite, build, lint, scheduler, Prometheus, or unrelated changes were run.

## Residual migration closure

Commit `88fe0e9d fix: preserve packed legacy attribution` closes the three residual migration findings:

- Legacy identity precomputation collects each distinct raw usage attribution once, matches it once against plaintext/v1/v2 legacy key records, and reuses the map for all history, daily, spend, and sanitization work. A packed-v2 key with 250 usage rows preserves `clientKeyId` and `$250` spend with exactly one verifier resolution.
- Successful repaired import sanitizes active sources and every `migrate-from-json-*` backup, including raw backups created by prior failed attempts.
- Empty-target safety now includes `kv`; a proofless schema-9 database with pre-existing KV state refuses retry and preserves both KV and raw rollback sources.

Focused verification: `npm --prefix tests test -- unit/db-migration-chain.test.js unit/client-key-migration.test.js` → **2 files, 13 tests, 0 failures**.

## Historical backup payload preservation

Commit `7f23b8c7 fix: sanitize legacy backups in place` makes sanitization payload-local:

- Active `db.json`/`usage.json` are sanitized from the active payload.
- Every `migrate-from-json-*` directory reads and sanitizes its own main/usage payload, preserving its distinct settings, rows, totals, metadata, and resolvable `clientKeyId` attribution while nulling raw `apiKey`.
- Same-second backup names receive a unique numeric suffix, preventing a repaired attempt from overwriting the failed attempt before sanitization.
- Verifier-match results are memoized only for identical record/raw pairs during the run, so active and identical backup payloads do not repeat KDF work while distinct historical payloads retain their own resolution map.

RED: the distinct-backup regression received repaired active settings in the failed backup.

GREEN: `npm --prefix tests test -- unit/db-migration-chain.test.js unit/client-key-migration.test.js` → **2 files, 13 tests, 0 failures**.

## Payload-local historical verifiers

Commit `6c091c55 fix: preserve backup key verifiers` ensures historical archives remain independently restorable:

- Active source and the current successful backup may use the current database verifier.
- Every older backup ignores active `storedById` even on ID collision, normalizes its own v1/v2 value, or packs its own plaintext once.
- Backup-only and same-ID/different-raw regressions prove each archived verifier matches only its own raw secret, never the active secret; usage attribution remains payload-local and raw bytes are absent.

RED: backup-only keys remained plaintext/null, and a same-ID backup received the active repaired verifier.

GREEN: focused migration suite → **2 files, 13 tests, 0 failures**.
