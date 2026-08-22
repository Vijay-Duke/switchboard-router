# Account Scheduler v2 — Implementation Report

## Result

Implemented the complete Account Scheduler v2 plan on `feat/account-scheduler-v2`, based on reviewed client-key commit `1228a363`. The scheduler is opt-in and process-local. Disabled providers retain the existing explicit-pin, strict-pin, fill-first, sticky round-robin, exclusion, model-lock, no-auth, proxy, and client-key behavior.

Enabled providers now get provider-scoped hashed TTL affinity, deterministic least-inflight/fresh-quota/priority/ID selection, best-effort per-connection cap filtering from observed pending counts, failover rebinding, bounded affinity state, and non-secret selection reasons.

Final focused verification passed **12 files, 88 tests, 0 failures**. Per assignment constraints, no full suite, production build, lint, formatter, telemetry work, push, or merge was run.

## Task 1 — Focused Scheduler v2 core

### Files

- `src/sse/services/accountScheduler.js`
- `tests/unit/account-scheduler.test.js`

### Behavior

- Added a focused functional selection module with no repository dependency.
- Affinity keys are SHA-256 hashes of `providerId + NUL + sessionKey`; raw session IDs are neither stored nor logged.
- Healthy live affinity wins and extends a sliding TTL. Expired affinity is swept and scored normally. Missing, filtered, locked, inactive, deleted, or capped bindings rebind to the best remaining candidate.
- Ranking is deterministic: observed in-flight count, fresh quota tier/headroom/reset, lower finite priority, then locale-compared string ID.
- Quota snapshots are usable only with numeric finite `at` and `remainingPercentage` values within the freshness window. Positive quota outranks unknown/stale, which outranks exhausted quota.
- Positive integer caps filter candidates using the existing observed process-local pending count. They are selection guards, not reservations or semaphores.
- Affinity memory is lazily swept and bounded at 5,000 entries by oldest Map insertion.

### TDD evidence

- RED: `unit/account-scheduler.test.js` failed because `accountScheduler.js` did not exist.
- GREEN: initial core suite passed **11 tests** covering least-inflight ordering, fresh/stale/exhausted quota, reset order, deterministic ties, caps, provider-scoped affinity, expiry, rebinding, bounded memory, and no candidates.
- Final RED correction: non-numeric priority/quota values produced the wrong reason and string caps were treated as integers.
- Final GREEN correction: scheduler/auth subset passed **19 tests** after strict numeric signal handling and a single-pass candidate ranking loop.

## Task 2 — Read-only in-flight accessor

### Files

- `src/lib/db/repos/usageRepo.js`
- `src/lib/db/index.js`
- `src/lib/usageDb.js`
- `tests/unit/connection-inflight.test.js`

### Behavior

- Added synchronous `getConnectionInFlightCount(connectionId)` over the existing `pendingRequests.byAccount` model refcounts.
- The accessor sums only positive finite counts and does not mutate counters, timers, or stats.
- Re-exported through the database barrel and compatibility shim.
- Left `trackPendingRequest`, streaming completion/release paths, and client-key attribution untouched.

### TDD evidence

- RED: all 3 new tests failed because the accessor and barrel exports were absent.
- GREEN: accessor plus existing SQLite/lowdb pending-tracking regression passed **2 files, 26 tests**.

## Task 3 — Safe no-fallback conversation key

### Files

- `open-sse/utils/sessionManager.js`
- `tests/unit/session-manager.test.js`

### Behavior

- Added `resolveAffinitySessionId` using the existing client-session extraction order and assistant-history store.
- Raw-header objects and platform `Headers` are supported.
- Empty bodies and user-only histories return `null`; the resolver never uses a workspace, connection ID, generated per-request fallback, or account identity.
- Existing `resolveSessionId`, `deriveSessionId`, and capture semantics remain unchanged.

### TDD evidence

- RED: 2 tests failed because `resolveAffinitySessionId` was absent.
- GREEN: all existing and new session priority/fallback tests passed **10 tests**.

## Task 4 — Auth and chat integration

### Files

- `src/sse/services/auth.js`
- `src/sse/handlers/chat.js`
- `tests/unit/auth-account-scheduler.test.js`
- `tests/unit/auth-preferred-connection.test.js`
- `tests/unit/claude-handler-credential-isolation.test.js`

### Behavior

- `getProviderCredentials` reads the nested provider scheduler setting only after canonical provider resolution and existing hard filters.
- Available explicit pins win with `selectionReason: "explicit-pin"`; strict unavailable pins do not fall back. A strict pinned connection at its observed cap returns the compatibility unavailable envelope with `capacityLimited: true`.
- Disabled/missing scheduler settings retain fill-first and sticky round-robin selection and persistence without reading scheduler counters.
- Enabled selection returns `selectionReason` and `affinityRebound`; all-cap selection returns the existing handler-compatible rate-limit envelope with reason `capacity-exhausted`.
- Proxy resolution remains after selection and uses the selected connection’s `providerSpecificData`.
- No-auth providers bypass scheduler counters.
- Chat resolves one affinity key before the account retry loop and passes that same key to every retry. Embedding, image, speech, search, and fetch bodies were not changed.
- AUTH selection logs include only visible reason/rebound metadata, never a session key or score tuple.

### TDD evidence

- RED: auth tests lacked scheduler metadata, scoring, cap envelope, disabled compatibility reasons, and counters; chat tests showed `sessionKey` missing on initial and retry credential calls.
- GREEN: account scheduler, in-flight, session, auth, chat, and strict model-probe regression set passed **7 files, 39 tests**.
- Tests explicitly cover strict/soft pinning, exclusions, model cooldown filtering, all-capped behavior, selected proxy preservation, no-auth bypass, retry-key stability, and absence of raw session values in AUTH logs.

## Task 5 — Write-boundary validation

### Files

- `src/app/api/settings/route.js`
- `src/app/api/providers/[id]/route.js`
- `tests/unit/provider-scheduler-settings.test.js`
- `tests/unit/provider-connection-cap-route.test.js`

### Behavior

- Nested scheduler settings require boolean `enabled` and integer `sessionAffinityTtlSeconds` from 60 through 86,400.
- Connection caps accept only `null` or integers from 1 through 1,024 when the field is present.
- Cap storage remains a top-level connection JSON field; proxy merge behavior is unchanged.
- Existing provider strategy siblings and unknown/current override fields pass through unchanged.

### TDD evidence

- RED: **15 tests** failed because invalid scheduler settings/caps were accepted and valid caps were dropped.
- GREEN: validation, proxy, and repository parity regressions passed **4 files, 42 tests**.

## Task 6 — Provider and connection controls

### Files

- `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js`
- `src/shared/components/EditConnectionModal.js`

### Behavior

- Both provider surfaces load and patch the same nested scheduler object with enabled state and 1–1,440 minute affinity.
- Scheduler and Round Robin writes use read-merge-write updates, preserving sibling, unknown, and nested fields.
- Round Robin settings remain visible, saved, and disabled with an explanatory title while balanced scheduling is enabled.
- Copy states process-local behavior, affinity failover, observed-count best-effort caps, possible brief concurrent overshoot, and Round Robin precedence.
- Connection editing uses blank for unlimited and persists `null`; bounded values clamp to 1–1,024 client-side while the route remains authoritative.

### Verification evidence

- Focused route/dashboard/proxy regressions passed **4 files, 24 tests**.
- React Doctor completed on the changed branch. It reported no scheduler-specific correctness or accessibility failure; broad pre-existing large-component/use-state diagnostics remained. Its scheduler single-pass iteration suggestion was applied in the final correction.
- Real Chromium QA covered both `/dashboard/providers/anthropic` and `/dashboard/media-providers/embedding/openai`:
  - Enabling the scheduler retained Round Robin, sticky, unknown provider, and unknown nested scheduler fields.
  - Round Robin became disabled with the saved-setting title.
  - Affinity values 1 and 1,440 persisted and reloaded as 60 and 86,400 seconds.
  - The shared media surface loaded the same nested state.
  - A 375px viewport had `scrollWidth === 375`; scheduler controls remained keyboard-focusable.
  - A temporary connection saved cap `1`, reloaded it as `1`, saved a cleared field as `null`, and direct cap `0` returned HTTP 400.
  - Temporary connections and scheduler QA settings were removed after verification.

## Final verification and scope audit

Command run from `tests/`:

```text
npx vitest run unit/account-scheduler.test.js unit/connection-inflight.test.js unit/session-manager.test.js unit/auth-account-scheduler.test.js unit/auth-preferred-connection.test.js unit/claude-handler-credential-isolation.test.js unit/model-probe-connection-pinning.test.js unit/provider-scheduler-settings.test.js unit/provider-connection-cap-route.test.js unit/db-sqlite-vs-lowdb.test.js unit/proxy-pool-ui-removal.test.js unit/dashboard-polish.test.js
```

Result: **12 files passed, 88 tests passed, 0 failed**.

Scope audit found no new schema/migration, dependency, distributed store, queue, wait loop, reservation counter, polling worker, telemetry implementation, raw-session logging, proxy-pool work, or edits to `open-sse/handlers/chatCore.js` / `open-sse/utils/stream.js`.

A live two-account upstream streaming smoke was not run because this isolated worktree had no valid pair of provider accounts. The focused auth, chat-retry, pending start/end, cap, proxy, cooldown, and affinity tests exercise the same public seams without making external provider requests.

## Commits

1. `e4a86149` — `feat: add account scheduler selection core`
2. `2616e738` — `feat: expose connection inflight counts`
3. `b2ef6890` — `feat: derive scheduler affinity from client sessions`
4. `3a404291` — `feat: integrate balanced account scheduling`
5. `fec77726` — `feat: validate account scheduler settings`
6. `b7d0cd46` — `feat: expose account scheduler controls`
7. `249e6e14` — `fix: close account scheduler regressions`

## Known operational concerns

- `maxConcurrentRequests` is intentionally a process-local best-effort selection cap based on observed pending counts. It does not reserve capacity; simultaneous selections can briefly overshoot, and multiple Switchboard processes do not coordinate.
- Affinity is process-local and intentionally disappears on restart. Multiple processes maintain independent bindings.
- Cleanup is lazy on scheduler selection/insertion; there is no background worker.
- The full repository suite, production build, lint, and formatter were intentionally not run under the assignment constraints.

## Review fix round 1

The merged correctness/security review found seven blocking gaps. Round 1 closes all findings:

- Added shared `withConnectionInFlight` lifecycle tracking to embeddings, image, STT, TTS, search, fetch, and native Gemini. Tracking begins before token refresh/upstream work, releases immediately for retries/errors/aborts, and wraps successful response bodies so EOF, stream error, or client cancel releases exactly once.
- Removed the 60-second force-clear timer. Exact request completion now exclusively owns pending-count release; work still live after 61 seconds remains counted.
- Scheduler selection now invalidates live affinity before `no-candidates` and `capacity-exhausted` returns. Auth invokes that invalidation even when exclusions/locks/deactivation/deletion remove every candidate, and exposes truthful reason/rebound metadata on the locked envelope.
- Affinity derivation and hashing use unambiguous tuples containing canonical provider, authenticated `clientKeyId` (or explicit `local-no-key`), and session source. Raw client session values are hashed at derivation and hashed again for scheduler storage.
- Affinity capacity is partitioned per canonical-provider/client scope (500 entries) with the 5,000 global guard retained. Scope pressure evicts from the offending scope; a new scope is not allowed to evict established scopes under global pressure. Assistant-history affinity is deterministic and stateless, eliminating its prior global cache/eviction channel.
- Request-log session headers and nested body carriers are fully redacted at JSON and legacy error sinks. Codex debug logs report only `session=resolved|pending`, never an identifier.
- Both provider control surfaces now use a tested read-merge-PATCH helper. Failed GET performs no PATCH; failed PATCH rejects; UI state changes only after successful persistence, so visible toggles/inputs roll back by remaining unchanged.

### Round 1 TDD evidence

- RED: focused review run produced **2 missing-module suites and 10 expected failures**: absent lifecycle/settings helpers, 60-second count loss, cross-client affinity collision, stale binding retention, cross-scope FIFO eviction, hard-filter metadata loss, missing chat client scope, raw request-log/Codex identifiers, and unscoped assistant derivation.
- GREEN: the focused round-1 proof passed **24 files, 132 tests, 0 failures**.
- The non-chat integration test holds an embeddings response body open at cap 1, proves an overlapping request receives 429 without entering provider core, consumes EOF to release, then proves the next request is admitted.
- Fake-clock coverage proves a live request remains counted beyond 60 seconds. A second same-model refcount proves stream cancellation releases exactly once rather than decrementing unrelated work.
- Request-log coverage enables disk logging and verifies the full raw identifier is absent across client, source, intermediate, target, and error files. Codex console coverage separately verifies absence from debug output.
- React Doctor on the round-1 diff reported only the two pre-existing many-`useState` architecture warnings in the provider components; no scheduler correctness or accessibility failure.

Focused command scope included scheduler/auth/session/refcount tests, all new round-1 tests, client-key abort behavior, native Gemini streaming/non-streaming, changed non-chat handler imports/abort paths, settings/routes, database parity, proxy, and dashboard regressions. Full suite/build/lint/format remained intentionally skipped.

### Round 1 commits

1. `4c147f7a` — `fix: track scheduler consumers safely`
2. `394188f9` — `fix: redact scheduler session identifiers`
3. `b43bb5d1` — `fix: save scheduler settings transactionally`
4. `37276586` — `fix: scope and count provider work precisely`
