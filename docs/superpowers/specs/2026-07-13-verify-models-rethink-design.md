# Verify Models — UX Rethink

**Date:** 2026-07-13
**Status:** Approved design, ready for implementation planning

## Problem

The "Verify models" flow on a provider page (`/dashboard/providers/[id]`) batch-pings
every model for availability + latency. Current pain points observed with a 2145-model
provider (`lite-llm`):

1. **No run indicator outside the panel.** Progress bar lives only inside the open
   `VerifyModelsPanel`. Hit "Hide verify" and you lose all sight of a running job.
2. **Dead models linger.** Removal is a manual "Remove unavailable custom" button after
   the run. Dead models (permanent failures) stay in the list with no obvious prompt.
3. **Import re-adds dead models.** `handleImportModels` has no awareness of the dead
   cache, so known-dead models get re-imported every time.
4. **Verify dies on navigation.** The batch loop is client-side (`for` loop in
   `VerifyModelsPanel` driving `fetch`). Navigate away or close the tab → the job stops.
5. **Confusing counters.** Progress shows `dead 0 · retry 650 · skipped dead 217`; the
   distinction between "dead", "skipped dead", and "retry" is unexplained.

## Core architectural shift

Verify moves from a **client-driven loop** to a **server-side background job** that the
client merely observes. This is the keystone change — it unlocks navigation-survival,
the toggle-button indicator, and per-row state, all of which just render shared job state.

Pattern precedent already in the codebase:
- `open-sse/routing/scheduler.js` — global-singleton background worker, HMR-safe via a
  `globalThis` guard, `running` flag prevents overlap, booted from `initializeApp`.
- `src/shared/services/quotaAutoPing.js` — same shape.

Verify job follows this exact pattern.

## Existing pieces reused verbatim

- `src/lib/model-probe/prepareModels.js` — `prepareProbeModels()` splits candidates into
  `eligible` / `skippedDead` (cached dead) / `cachedOk` / duplicates.
- `src/lib/model-probe/index.js` — `runBatch()`, `clampProbeOptions()`,
  `buildModelProbeScopeKey()`.
- `src/lib/db/repos/modelProbeRepo.js` — `upsertProbeResult`, `getProbesForScope`,
  `getDeadModelIds`, `clearProbes`, `deleteProbeRows`.
- `src/lib/model-probe/classifyFailure.js` — maps a probe result to
  `ok | dead | retryable` and a `failureClass`. **Dead** = `not_found` (404 / "model not
  found") or `access_denied` (403 / forbidden). **Retryable** = timeout, 429, 5xx,
  network, 401-auth.
- Batch route `.../model-probes/batch` — stays as the primitive the job calls internally.

## Components

### 1. Server-side verify job runner — `src/lib/model-probe/verifyJob.js`

Global singleton (HMR-safe via `globalThis`, mirroring `scheduler.js`). Keyed by
`connectionId` (one verify per connection at a time).

Job state shape:

```
{
  connectionId, scopeKey, providerAlias,
  status: "idle" | "running" | "done" | "cancelled" | "error",
  total, done, ok, dead, retryable, skippedDead, skippedDup,
  currentRange: { from, to } | null,   // e.g. 701..750
  perModel: Map<modelId, "testing" | "ok" | "dead" | "retry">,
  startedAt, finishedAt, error,
  opts: { concurrency, batchSize, timeoutMs },
}
```

Behaviour:
- `startVerify({ connectionId, models, providerAlias, opts })`:
  - Guard: if a job for this `connectionId` is already `running`, return it (no overlap —
    mirrors `scheduler.js` `g.running` guard).
  - Runs `prepareProbeModels` → seeds `skippedDead`/`skippedDup`/`total`.
  - Drives the batch loop server-side: for each chunk, mark chunk models `testing`,
    call `runBatch`, `upsertProbeResult` each result, update counters + `perModel`.
  - Sets `status="done"` (or `"cancelled"`/`"error"`) at the end. Keeps final state
    resident so a late-arriving client still sees the summary.
- `getVerifyStatus(connectionId)` → serializable snapshot (`perModel` → plain object).
- `cancelVerify(connectionId)` → sets a cancel flag; loop breaks after the current batch
  (partial results already persisted per batch).
- On provider-auth failure across a whole batch (existing `authFailure` detection),
  set `status="error"` with the auth message and stop.

No new DB table — job state is in-memory (ephemeral). Probe *results* keep persisting to
`provider_model_probe` per batch (durable), so a server restart mid-run loses only the
"currently running" status, not completed probe results.

### 2. API surface — `src/app/api/providers/[id]/model-probes/verify/`

- `POST verify/start` — body `{ models, providerAlias, concurrency, batchSize, timeoutMs }`.
  Kicks the singleton, returns the initial snapshot immediately (does not block on the run).
- `GET verify/status` — returns `getVerifyStatus(connectionId)`. Client polls ~1s.
- `POST verify/cancel` — calls `cancelVerify`.

Existing routes kept: `batch` (job primitive), `cache` (DELETE clears probes),
`remove-unavailable` (extended, see §7), `prepare` (still callable, though the job now
calls `prepareProbeModels` directly server-side).

### 3. Client as observer — `VerifyModelsPanel.js` rework

- Remove the client-side batch `for` loop entirely.
- On mount: `GET verify/status`. If `running`, attach and resume rendering (survives
  navigation / panel reopen).
- Start button → `POST verify/start`, then poll `verify/status` every ~1s until terminal
  (`done`/`cancelled`/`error`).
- Cancel button → `POST verify/cancel`.
- Clear cache / remove-unavailable unchanged (still DELETE/POST as today).
- Panel close does NOT stop the job.

### 4. Toggle-button run indicator — `page.js`

- Page-level lightweight poll of `verify/status` (shared with the panel poller — lift the
  poller into `page.js` and pass status down to avoid double-polling).
- When `status==="running"`: the "Verify models" toggle button shows a spinner + live
  `done/total` (e.g. `700/2145`) even while the panel is collapsed.

### 5. Per-model row state — `ModelRow.js` / models list

- Rows read `perModel[modelId]` from job status: `ok` / `dead` / `retry` badge;
  the current batch window is highlighted ("testing 701–750").
- **Scale decision:** batch-window highlight + post-batch badge commit, NOT per-row live
  spinners. Rationale: `perModel` updates per batch (~50 models), the list is not
  virtualized today, and 2145 simultaneously-spinning rows would thrash React. Highlight
  the active range; commit badges when each batch returns. No virtualization work needed.
- Badges persist across page loads from the probe cache (see §6).

### 6. Persistent badge + filter — `ModelsCard.js` / models list

- On page load, hydrate model badges from `getProbesForScope(providerId, scopeKey)` so
  `ok`/`dead`/`retry` state is visible anytime, not only during a run.
- Add a filter control: **All / OK / Dead / Retry**, plus a "Hide dead" toggle.

### 7. One-click remove after run — `remove-unavailable` route + panel summary

- When a run finishes with `dead > 0`, show a prominent `Remove {dead} dead` button
  (count from job summary).
- Removal policy (reversible-safe default):
  - **Custom models** classified dead → hard-deleted (`deleteProbeRows` + custom-model
    delete), as today.
  - **Wildcard / built-in catalog entries** (e.g. `bedrock/*`) → never hard-deleted;
    flagged/disabled instead so they can be recovered without re-import.
- No silent deletion during the run — removal is always a deliberate click.

### 8. Import skips dead + auto-verify — `handleImportModels` in `page.js`

- Before building `toAdd`, fetch `getDeadModelIds(providerId, scopeKey, "llm")` (via a
  small GET) and filter out candidates whose id is in the dead set.
- Result message: `Imported X new · Y skipped (known dead)`. Re-importable after
  "Clear cache".
- After a successful import, auto-`POST verify/start` on the active connection so the new
  list self-validates without a second manual click.

### 9. Stat clarity — `VerifyModelsPanel` + summary

Unify and explain the counters (same wording in progress line and summary), with tooltips:
- **tested** — models actually probed this run.
- **ok** — reachable.
- **dead** — found permanently unavailable this run (404 not-found / 403 access-denied).
- **retry** — transient failure this run (timeout / 429 / 5xx / network / 401-auth);
  re-testable.
- **skipped (known dead)** — models NOT probed because the cache already marks them dead;
  cleared by "Clear cache".
- **dupes** — duplicate ids collapsed.

## Data flow

```
User clicks Start (or Import triggers auto-verify)
  → POST verify/start
    → verifyJob singleton: prepareProbeModels → loop { runBatch → upsertProbeResult → update state }
  → client + page.js poll GET verify/status every ~1s
    → panel progress bar, toggle-button count, per-row badges all render from one snapshot
  → job reaches done
    → summary + "Remove N dead" button
  (navigating away / hiding panel does not stop the job; re-attaching resumes rendering)
```

## Error handling

- Whole-batch provider-auth failure → job `status="error"`, surfaced in panel; stop.
- Individual dead/retryable results → recorded, run continues.
- Server restart mid-run → in-memory job status lost (client poll returns `idle`);
  completed probe results already persisted, so a re-run resumes from the cache
  (dead-skip + cachedOk keep it cheap).
- Cancel → break after current batch; partial results persisted; `status="cancelled"`.

## Testing

- **verifyJob unit tests**: overlap guard (second start returns running job); counters +
  `perModel` transitions across batches; cancel breaks after current batch; auth-failure →
  error; `skippedDead`/`skippedDup` seeded from prepare.
- **classifyFailure** already covered; add cases if the dead/retry taxonomy shifts.
- **API routes**: start returns snapshot without blocking; status reflects progress;
  cancel flips state.
- **Import filter**: candidates in dead set are excluded; message counts correct;
  auto-verify fired after import.
- **Remove policy**: custom dead hard-deleted; wildcard/built-in flagged not deleted.

## Out of scope (deferred)

- List virtualization (only needed if per-row live spinners were chosen — they weren't).
- Retry-only re-run button (a "Re-test retryable" action) — nice-to-have, not this pass.
- Aggressive auto-remove-during-run — explicitly rejected in favour of one-click.

## Non-obvious decisions

- **In-memory job state, durable probe results.** Avoids a new table + migration. The only
  thing lost on restart is the "is running" flag; results are safe. Matches the ephemeral
  nature of `scheduler.js`.
- **Batch-window highlight over per-row spinners.** Deliberate perf call for 2000+ rows.
- **One-click remove, not silent auto-delete.** Reversible default; wildcard/built-in
  entries never hard-deleted.
