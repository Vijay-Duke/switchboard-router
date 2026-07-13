# Verify Models UX Rethink — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move model verification from a client-driven loop to a server-side background job the client observes, so verify survives navigation, shows progress everywhere, auto-skips known-dead models on import, and offers one-click cleanup of dead models.

**Architecture:** A global-singleton job runner (`verifyJob.js`, mirroring `open-sse/routing/scheduler.js`) drives the existing `prepareProbeModels` → `runBatch` → `upsertProbeResult` pipeline server-side. New `verify/start|status|cancel` API routes expose it. `VerifyModelsPanel` becomes a thin poller. Toggle button, per-model badges, filters, one-click remove, and import skip-dead all render/consume the shared job + probe-cache state.

**Tech Stack:** Next.js (custom server), React (client components, PropTypes), Vitest, node/bun sqlite via existing repos. JavaScript with `// @ts-check` JSDoc — NOT TypeScript.

## Global Constraints

- Language: JavaScript with `// @ts-check` + JSDoc. No TypeScript syntax (no `: type`, interfaces, generics).
- Probe dead taxonomy (from `classifyFailure.js`): **dead** = `not_found` (404) or `access_denied` (403); **retryable** = timeout / 429 / 5xx / network / 401-auth.
- Probe caps (`MODEL_PROBE_CAPS`): defaultConcurrency 4, maxConcurrency 16, defaultBatchSize 50, maxBatchSize 200, defaultTimeoutMs 20000, maxTimeoutMs 60000.
- Singleton pattern: `const g = (global.__verifyJob ??= { ... })` — HMR-safe, exactly as `scheduler.js`.
- Job state is in-memory (ephemeral); probe RESULTS persist per batch to `provider_model_probe`.
- One verify job per `connectionId` at a time (overlap guard).
- Reversible removal: custom dead → hard-delete; wildcard/built-in catalog entries → never hard-deleted.
- Tests run from `tests/` dir via `npx vitest run <path>` (relative to repo root, e.g. `unit/foo.test.js`). Test files import source with `../../` relative paths.
- Commit messages end with `Assistant-model: Claude Code`.

## Reused interfaces (already exist — do not reimplement)

- `src/lib/model-probe/index.js`: `MODEL_PROBE_CAPS`, `clampProbeOptions(opts)`, `canonicalModelId(id, alias)`, `classifyFailure(input)`, `buildModelProbeScopeKey(connection)`, `runBatch({models, providerAlias, concurrency, batchSize, timeoutMs, warmup, baseUrl})`, `prepareProbeModels({models, probes, providerAlias})`.
- `runBatch` result item: `{ modelId, canonicalId, kind, latencyMs, probeStatus: "ok"|"dead"|"retryable", failureClass, failureMessage, checkedAt }`. Returns `{ results, caps }`.
- `prepareProbeModels` returns `{ eligible[], skippedDead[], skippedFreshOk[], cachedOk[], stats: { total, invalid, duplicates, skippedDead, cachedOk, eligible } }`. Each eligible/candidate: `{ id, modelId, canonicalId, name, kind, type, fullModel }`.
- `src/lib/db/repos/modelProbeRepo.js` (re-exported via `@/lib/db/index.js`): `upsertProbeResult({providerId, scopeKey, modelId, kind, status, latencyMs, failureClass, failureMessage, checkedAt})`, `getProbesForScope(providerId, scopeKey)` → `[{modelId, kind, status, latencyMs, failureClass, checkedAt}]`, `getDeadModelIds(providerId, scopeKey, kind?)` → `string[]` (canonical ids), `clearProbes`, `deleteProbeRows`.
- `PROVIDER_ID_TO_ALIAS` from `open-sse/config/providerModels.js`.
- Batch route (`src/app/api/providers/[id]/model-probes/batch/route.js`) — pattern reference for auth handling + `upsertProbeResult` loop.

---

### Task 1: Verify job runner core (state + start/status/cancel)

**Files:**
- Create: `src/lib/model-probe/verifyJob.js`
- Test: `tests/unit/verify-job.test.js`

**Interfaces:**
- Consumes: `prepareProbeModels`, `runBatch`, `clampProbeOptions` from `../../src/lib/model-probe/index.js`; `upsertProbeResult`, `getProbesForScope` injected as deps for testability.
- Produces:
  - `startVerify({ connectionId, scopeKey, providerId, providerAlias, models, opts, baseUrl, deps })` → `Promise<snapshot>` (returns initial snapshot synchronously-ish; the run continues in the background).
  - `getVerifyStatus(connectionId)` → `snapshot | null`.
  - `cancelVerify(connectionId)` → `boolean`.
  - `snapshot` = `{ connectionId, scopeKey, providerAlias, status: "idle"|"running"|"done"|"cancelled"|"error", total, done, ok, dead, retryable, skippedDead, skippedDup, currentRange: {from,to}|null, perModel: Record<modelId, "testing"|"ok"|"dead"|"retry">, startedAt, finishedAt, error }`.
  - `__resetVerifyJobForTests()`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/verify-job.test.js
import { describe, expect, it, beforeEach } from "vitest";
import {
  startVerify,
  getVerifyStatus,
  cancelVerify,
  __resetVerifyJobForTests,
} from "../../src/lib/model-probe/verifyJob.js";

// runBatch is real, but we inject fake probe fns + a fake batch runner via deps.
function makeDeps(overrides = {}) {
  const upserts = [];
  return {
    upserts,
    upsertProbeResult: async (r) => { upserts.push(r); },
    getProbesForScope: async () => [],
    // fake runBatch: every model ok with latency 10
    runBatch: async ({ models }) => ({
      results: models.map((m) => ({
        modelId: m.id, canonicalId: m.canonicalId, kind: m.kind,
        latencyMs: 10, probeStatus: "ok", failureClass: null,
        failureMessage: null, checkedAt: "2026-07-13T00:00:00.000Z",
      })),
      caps: {},
    }),
    ...overrides,
  };
}

const MODELS = [
  { id: "a", canonicalId: "a", kind: "llm" },
  { id: "b", canonicalId: "b", kind: "llm" },
  { id: "c", canonicalId: "c", kind: "llm" },
];

describe("verifyJob core", () => {
  beforeEach(() => __resetVerifyJobForTests());

  it("runs to completion and counts ok", async () => {
    const deps = makeDeps();
    await startVerify({
      connectionId: "c1", scopeKey: "s1", providerId: "p", providerAlias: "p",
      models: MODELS, opts: { concurrency: 2, batchSize: 2, timeoutMs: 1000 },
      baseUrl: "http://x", deps,
    });
    // allow background loop to finish
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c1");
    expect(s.status).toBe("done");
    expect(s.ok).toBe(3);
    expect(s.dead).toBe(0);
    expect(s.total).toBe(3);
    expect(deps.upserts).toHaveLength(3);
  });

  it("overlap guard returns the running job instead of starting a second", async () => {
    let resolveBatch;
    const gate = new Promise((r) => { resolveBatch = r; });
    const deps = makeDeps({
      runBatch: async ({ models }) => {
        await gate;
        return { results: models.map((m) => ({ modelId: m.id, canonicalId: m.canonicalId, kind: m.kind, latencyMs: 1, probeStatus: "ok", failureClass: null, failureMessage: null, checkedAt: "t" })), caps: {} };
      },
    });
    const first = startVerify({ connectionId: "c1", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    const second = await startVerify({ connectionId: "c1", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    expect(second.status).toBe("running");
    resolveBatch();
    await first;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tests/`): `npx vitest run unit/verify-job.test.js`
Expected: FAIL — `verifyJob.js` does not exist / imports undefined.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/model-probe/verifyJob.js
// @ts-check
import { prepareProbeModels, runBatch as realRunBatch, clampProbeOptions } from "./index.js";

const g = (global.__verifyJob ??= {
  /** @type {Map<string, any>} connectionId -> job */
  jobs: new Map(),
});

function snapshot(job) {
  if (!job) return null;
  return {
    connectionId: job.connectionId,
    scopeKey: job.scopeKey,
    providerAlias: job.providerAlias,
    status: job.status,
    total: job.total,
    done: job.done,
    ok: job.ok,
    dead: job.dead,
    retryable: job.retryable,
    skippedDead: job.skippedDead,
    skippedDup: job.skippedDup,
    currentRange: job.currentRange,
    perModel: { ...job.perModel },
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}

export function getVerifyStatus(connectionId) {
  return snapshot(g.jobs.get(connectionId));
}

export function cancelVerify(connectionId) {
  const job = g.jobs.get(connectionId);
  if (!job || job.status !== "running") return false;
  job.cancel = true;
  return true;
}

export function __resetVerifyJobForTests() {
  g.jobs = new Map();
}

/**
 * Start (or return the already-running) verify job for a connection.
 */
export async function startVerify({ connectionId, scopeKey, providerId, providerAlias, models, opts, baseUrl, deps }) {
  const existing = g.jobs.get(connectionId);
  if (existing && existing.status === "running") return snapshot(existing);

  const runBatch = deps?.runBatch || realRunBatch;
  const upsertProbeResult = deps?.upsertProbeResult;
  const getProbesForScope = deps?.getProbesForScope || (async () => []);
  const clamped = clampProbeOptions(opts || {});

  const probes = await getProbesForScope(providerId, scopeKey);
  const prep = prepareProbeModels({ models, probes, providerAlias });
  const eligible = prep.eligible;

  const job = {
    connectionId, scopeKey, providerAlias,
    status: "running",
    total: eligible.length,
    done: 0, ok: 0, dead: 0, retryable: 0,
    skippedDead: prep.stats.skippedDead,
    skippedDup: prep.stats.duplicates,
    currentRange: null,
    perModel: {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    cancel: false,
  };
  g.jobs.set(connectionId, job);

  // Run loop in background — do NOT await here.
  (async () => {
    try {
      for (let i = 0; i < eligible.length; i += clamped.batchSize) {
        if (job.cancel) { job.status = "cancelled"; break; }
        const chunk = eligible.slice(i, i + clamped.batchSize);
        job.currentRange = { from: i + 1, to: Math.min(i + chunk.length, eligible.length) };
        for (const m of chunk) job.perModel[m.canonicalId] = "testing";

        const { results } = await runBatch({
          models: chunk, providerAlias,
          concurrency: clamped.concurrency, batchSize: clamped.batchSize,
          timeoutMs: clamped.timeoutMs, warmup: i === 0, baseUrl,
        });

        for (const r of results) {
          if (upsertProbeResult) {
            await upsertProbeResult({
              providerId, scopeKey, modelId: r.canonicalId, kind: r.kind,
              status: r.probeStatus, latencyMs: r.latencyMs,
              failureClass: r.failureClass, failureMessage: r.failureMessage, checkedAt: r.checkedAt,
            });
          }
          if (r.probeStatus === "ok") { job.ok += 1; job.perModel[r.canonicalId] = "ok"; }
          else if (r.probeStatus === "dead") { job.dead += 1; job.perModel[r.canonicalId] = "dead"; }
          else { job.retryable += 1; job.perModel[r.canonicalId] = "retry"; }
        }
        job.done += results.length;
      }
      if (job.status === "running") job.status = "done";
    } catch (e) {
      job.status = "error";
      job.error = e?.message || String(e);
    } finally {
      job.currentRange = null;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return snapshot(job);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/verify-job.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-probe/verifyJob.js tests/unit/verify-job.test.js
git commit -m "feat(verify): server-side verify job runner core

Assistant-model: Claude Code"
```

---

### Task 2: Cancel + auth-failure handling in the job

**Files:**
- Modify: `src/lib/model-probe/verifyJob.js`
- Test: `tests/unit/verify-job.test.js` (extend)

**Interfaces:**
- Consumes: Task 1's `startVerify`/`getVerifyStatus`/`cancelVerify`.
- Produces: cancel breaks after current batch → `status="cancelled"`; a batch where every result has `failureClass==="auth"` → `status="error"`, `error` set, loop stops.

- [ ] **Step 1: Write the failing tests (append to describe block)**

```javascript
  it("cancel stops after the current batch", async () => {
    const deps = makeDeps();
    await startVerify({ connectionId: "c2", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 1, timeoutMs: 1 }, baseUrl: "x", deps });
    cancelVerify("c2");
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c2");
    expect(["cancelled", "done"]).toContain(s.status); // cancelled if caught mid-run
    expect(s.done).toBeLessThanOrEqual(3);
  });

  it("all-auth-failure batch sets status error", async () => {
    const deps = makeDeps({
      runBatch: async ({ models }) => ({
        results: models.map((m) => ({ modelId: m.id, canonicalId: m.canonicalId, kind: m.kind, latencyMs: 1, probeStatus: "retryable", failureClass: "auth", failureMessage: "HTTP 401", checkedAt: "t" })),
        caps: {},
      }),
    });
    await startVerify({ connectionId: "c3", scopeKey: "s", providerId: "p", providerAlias: "p", models: MODELS, opts: { concurrency: 1, batchSize: 3, timeoutMs: 1 }, baseUrl: "x", deps });
    await new Promise((r) => setTimeout(r, 50));
    const s = getVerifyStatus("c3");
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/auth/i);
  });
```

- [ ] **Step 2: Run test to verify the auth test fails**

Run (from `tests/`): `npx vitest run unit/verify-job.test.js`
Expected: the `all-auth-failure` test FAILS (status is `done`, not `error`).

- [ ] **Step 3: Add auth-failure detection in the loop**

In `verifyJob.js`, inside the background loop, right after `const { results } = await runBatch(...)`, before the results loop:

```javascript
        const authFailure = results.length > 0 && results.every((r) => r.failureClass === "auth");
        if (authFailure) {
          job.status = "error";
          job.error = "Provider authentication failed for every probed model. Check this connection before retrying.";
          break;
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/verify-job.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-probe/verifyJob.js tests/unit/verify-job.test.js
git commit -m "feat(verify): job cancel + provider-auth-failure handling

Assistant-model: Claude Code"
```

---

### Task 3: verify/start, verify/status, verify/cancel API routes

**Files:**
- Create: `src/app/api/providers/[id]/model-probes/verify/start/route.js`
- Create: `src/app/api/providers/[id]/model-probes/verify/status/route.js`
- Create: `src/app/api/providers/[id]/model-probes/verify/cancel/route.js`
- Test: `tests/unit/verify-routes.test.js`

**Interfaces:**
- Consumes: `startVerify`, `getVerifyStatus`, `cancelVerify` from `@/lib/model-probe/verifyJob.js`; `getProviderConnectionById`, `upsertProbeResult`, `getProbesForScope` from `@/lib/db/index.js`; `buildModelProbeScopeKey` + `PROVIDER_ID_TO_ALIAS`.
- Produces: HTTP endpoints. `start` POST body `{ models, providerAlias, concurrency, batchSize, timeoutMs }` → 200 snapshot. `status` GET → snapshot or `{ status: "idle" }`. `cancel` POST → `{ cancelled: boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/unit/verify-routes.test.js
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "openai-compatible", providerSpecificData: { baseUrl: "https://x" } })),
  upsertProbeResult: vi.fn(async () => {}),
  getProbesForScope: vi.fn(async () => []),
}));

const startVerify = vi.fn(async () => ({ status: "running", total: 2, done: 0 }));
const getVerifyStatus = vi.fn(() => ({ status: "running", done: 1, total: 2 }));
const cancelVerify = vi.fn(() => true);
vi.mock("@/lib/model-probe/verifyJob.js", () => ({ startVerify, getVerifyStatus, cancelVerify }));

const { POST: startPOST } = await import("../../src/app/api/providers/[id]/model-probes/verify/start/route.js");
const { GET: statusGET } = await import("../../src/app/api/providers/[id]/model-probes/verify/status/route.js");
const { POST: cancelPOST } = await import("../../src/app/api/providers/[id]/model-probes/verify/cancel/route.js");

const params = Promise.resolve({ id: "c1" });
const req = (body) => ({ json: async () => body });

describe("verify routes", () => {
  beforeEach(() => { startVerify.mockClear(); getVerifyStatus.mockClear(); cancelVerify.mockClear(); });

  it("start kicks the job and returns a snapshot", async () => {
    const res = await startPOST(req({ models: [{ id: "a" }, { id: "b" }], providerAlias: "openai-compatible" }), { params });
    const data = await res.json();
    expect(startVerify).toHaveBeenCalledOnce();
    expect(data.status).toBe("running");
  });

  it("status returns the snapshot", async () => {
    const res = await statusGET({}, { params });
    const data = await res.json();
    expect(data.done).toBe(1);
  });

  it("cancel calls cancelVerify", async () => {
    const res = await cancelPOST(req({}), { params });
    const data = await res.json();
    expect(cancelVerify).toHaveBeenCalledWith("c1");
    expect(data.cancelled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tests/`): `npx vitest run unit/verify-routes.test.js`
Expected: FAIL — route files do not exist.

- [ ] **Step 3: Write the three routes**

```javascript
// src/app/api/providers/[id]/model-probes/verify/start/route.js
// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/index.js";
import { startVerify } from "@/lib/model-probe/verifyJob.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const providerAlias = body.providerAlias || PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider;
    const scopeKey = buildModelProbeScopeKey(connection);
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const snapshot = await startVerify({
      connectionId: connection.id,
      scopeKey,
      providerId: connection.provider,
      providerAlias,
      models: body.models || [],
      opts: { concurrency: body.concurrency, batchSize: body.batchSize, timeoutMs: body.timeoutMs },
      baseUrl,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    console.log("Error starting verify job:", error);
    return NextResponse.json({ error: "Failed to start verify" }, { status: 500 });
  }
}
```

```javascript
// src/app/api/providers/[id]/model-probes/verify/status/route.js
// @ts-check
import { NextResponse } from "next/server";
import { getVerifyStatus } from "@/lib/model-probe/verifyJob.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const snapshot = getVerifyStatus(id);
  return NextResponse.json(snapshot || { status: "idle" }, { headers: { "Cache-Control": "no-store" } });
}
```

```javascript
// src/app/api/providers/[id]/model-probes/verify/cancel/route.js
// @ts-check
import { NextResponse } from "next/server";
import { cancelVerify } from "@/lib/model-probe/verifyJob.js";

export const dynamic = "force-dynamic";

export async function POST(_request, { params }) {
  const { id } = await params;
  const cancelled = cancelVerify(id);
  return NextResponse.json({ cancelled });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/verify-routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/providers/[id]/model-probes/verify" tests/unit/verify-routes.test.js
git commit -m "feat(verify): start/status/cancel API routes

Assistant-model: Claude Code"
```

---

### Task 4: `startVerify` route must inject real DB deps

**Files:**
- Modify: `src/app/api/providers/[id]/model-probes/verify/start/route.js`

**Interfaces:**
- Consumes: `upsertProbeResult`, `getProbesForScope` from `@/lib/db/index.js`.
- Produces: the running job persists probe results (previously the job had no `deps` → no upsert).

Rationale: Task 1's `startVerify` only persists when `deps.upsertProbeResult` is provided. Routes run in the Next server where `@/lib/db/index.js` is available, so inject it there (keeps `verifyJob.js` free of a static DB import, matching the `runtimeDeps` philosophy).

- [ ] **Step 1: Add the import**

At top of `verify/start/route.js`, extend the db import:

```javascript
import { getProviderConnectionById, upsertProbeResult, getProbesForScope } from "@/lib/db/index.js";
```

- [ ] **Step 2: Pass deps into startVerify**

Change the `startVerify({ ... })` call to add:

```javascript
      baseUrl,
      deps: { upsertProbeResult, getProbesForScope },
    });
```

- [ ] **Step 3: Verify existing route test still passes**

Run (from `tests/`): `npx vitest run unit/verify-routes.test.js`
Expected: PASS (deps object is passed; mock ignores it).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/providers/[id]/model-probes/verify/start/route.js"
git commit -m "feat(verify): inject db deps so job persists probe results

Assistant-model: Claude Code"
```

---

### Task 5: VerifyModelsPanel → poll-based observer

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js`

**Interfaces:**
- Consumes: `POST /api/providers/{connectionId}/model-probes/verify/start`, `GET .../verify/status`, `POST .../verify/cancel`.
- Produces: same visual panel, but driven by polling job status. Adds prop `pollMs` (default 1000). Still calls `onComplete(summary)` and `onLatencyMap(map)` when a run reaches `done`/`cancelled`.

- [ ] **Step 1: Replace the client-side loop with start + poll**

Replace `handleStart`, `handleCancel`, and the `progress`/`summary` derivation. New `handleStart`:

```javascript
  async function handleStart() {
    if (running || !connectionId || modelCount === 0) return;
    setRunning(true);
    setError("");
    setSummary(null);
    setLogLine("Starting…");
    const opts = clampLocal();
    try {
      const res = await fetch(`/api/providers/${connectionId}/model-probes/verify/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models, providerAlias, ...opts, timeoutMs: opts.timeoutMs }),
      });
      const snap = await res.json().catch(() => ({}));
      if (!res.ok) { setError(snap.error || "Failed to start"); setRunning(false); return; }
      applySnapshot(snap);
      startPolling();
    } catch (e) {
      setError(e?.message || "Verify failed");
      setRunning(false);
    }
  }
```

Add polling + snapshot handling helpers inside the component:

```javascript
  const pollRef = useRef(/** @type {any} */ (null));

  function applySnapshot(snap) {
    if (!snap) return;
    setProgress({
      done: snap.done || 0,
      total: snap.total || 0,
      ok: snap.ok || 0,
      dead: snap.dead || 0,
      retryable: snap.retryable || 0,
      skippedDead: snap.skippedDead || 0,
      skippedDup: snap.skippedDup || 0,
    });
    if (snap.currentRange) {
      setLogLine(`Probing ${snap.currentRange.from}–${snap.currentRange.to} of ${snap.total}…`);
    }
    if (snap.error) setError(snap.error);
    const terminal = snap.status === "done" || snap.status === "cancelled" || snap.status === "error";
    if (terminal) {
      stopPolling();
      setRunning(false);
      const finalSummary = {
        ok: snap.ok || 0, dead: snap.dead || 0, retryable: snap.retryable || 0,
        tested: snap.done || 0, skippedDead: snap.skippedDead || 0, skippedDup: snap.skippedDup || 0,
        cancelled: snap.status === "cancelled",
      };
      setSummary(finalSummary);
      setLogLine(snap.status === "cancelled" ? "Cancelled (partial results saved)." : snap.status === "error" ? "Stopped." : "Done.");
      onComplete?.(finalSummary);
      // Latency map is derived by the parent from the probe cache reload; no per-run map needed.
      onLatencyMap?.({});
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/providers/${connectionId}/model-probes/verify/status`, { cache: "no-store" });
        const snap = await r.json().catch(() => null);
        applySnapshot(snap);
      } catch { /* transient poll error — keep polling */ }
    }, pollMs);
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function handleCancel() {
    await fetch(`/api/providers/${connectionId}/model-probes/verify/cancel`, { method: "POST" }).catch(() => {});
  }
```

- [ ] **Step 2: Re-attach to a running job on mount (survives navigation)**

Add a `useEffect` near the top of the component body:

```javascript
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/providers/${connectionId}/model-probes/verify/status`, { cache: "no-store" });
        const snap = await r.json().catch(() => null);
        if (cancelled || !snap) return;
        if (snap.status === "running") { setRunning(true); applySnapshot(snap); startPolling(); }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);
```

Add `useEffect` to the React import at the top (currently `useMemo, useRef, useState`):

```javascript
import { useEffect, useMemo, useRef, useState } from "react";
```

Add `pollMs = 1000` to the destructured props and to PropTypes (`pollMs: PropTypes.number`).

- [ ] **Step 3: Manual verification (server behavior)**

This is a UI-behavior change; verify by driving the app in Task 11. For now confirm no syntax break:

Run: `node --check "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"`
Expected: JSX file — `node --check` will error on JSX. Instead run lint scoped to the file: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"`
Expected: 0 errors (warnings ok).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"
git commit -m "feat(verify): panel observes server job via polling (survives navigation)

Assistant-model: Claude Code"
```

---

### Task 6: Lift status poll to page.js + toggle-button indicator

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js`

**Interfaces:**
- Consumes: `GET .../verify/status`.
- Produces: `verifyStatus` state in page.js (`{ status, done, total }`), polled while `running`; the "Verify models" toggle button renders a spinner + `done/total` when running even if the panel is hidden.

- [ ] **Step 1: Add verify-status polling state**

Near the other `useState` calls in the component (after `showVerifyPanel`):

```javascript
  const [verifyStatus, setVerifyStatus] = useState(/** @type {null|{status:string,done:number,total:number}} */ (null));
```

Add an effect that polls whenever there is an active connection:

```javascript
  useEffect(() => {
    const activeConn = connections.find((c) => c.isActive !== false);
    if (!activeConn) return;
    let stop = false;
    let interval = null;
    const poll = async () => {
      try {
        const r = await fetch(`/api/providers/${activeConn.id}/model-probes/verify/status`, { cache: "no-store" });
        const snap = await r.json().catch(() => null);
        if (stop) return;
        setVerifyStatus(snap && snap.status ? snap : null);
        const isRunning = snap?.status === "running";
        if (!isRunning && interval) { clearInterval(interval); interval = null; }
        if (isRunning && !interval) { interval = setInterval(poll, 1500); }
      } catch { /* ignore */ }
    };
    poll();
    return () => { stop = true; if (interval) clearInterval(interval); };
  }, [connections]);
```

(`useEffect` is already imported in page.js.)

- [ ] **Step 2: Show progress on the toggle button**

Find the "Verify models" toggle button (around line 1588-1596, the `modelToolbarActions.showVerify` block). Replace its label expression:

```javascript
                    {verifyStatus?.status === "running"
                      ? `Verifying ${verifyStatus.done}/${verifyStatus.total}`
                      : showVerifyPanel ? "Hide verify" : "Verify models"}
```

If the button accepts an `icon` prop, set it to `verifyStatus?.status === "running" ? "progress_activity" : "science"`.

- [ ] **Step 3: Lint the file**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/page.js"`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/page.js"
git commit -m "feat(verify): toggle-button shows live progress while running

Assistant-model: Claude Code"
```

---

### Task 7: Probe-cache badge data on page load

**Files:**
- Create: `src/app/api/providers/[id]/model-probes/route.js` (GET all probes for the connection scope)
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- Test: `tests/unit/model-probes-list-route.test.js`

**Interfaces:**
- Consumes: `getProviderConnectionById`, `getProbesForScope` from `@/lib/db/index.js`; `buildModelProbeScopeKey`.
- Produces: `GET /api/providers/{id}/model-probes` → `{ probes: [{ modelId, kind, status, latencyMs, failureClass, checkedAt }] }`. page.js loads it into `probeByModel` state: `Record<canonicalId, "ok"|"dead"|"retry">`.

- [ ] **Step 1: Write the failing route test**

```javascript
// tests/unit/model-probes-list-route.test.js
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "p", providerSpecificData: { baseUrl: "https://x" } })),
  getProbesForScope: vi.fn(async () => [
    { modelId: "a", kind: "llm", status: "ok", latencyMs: 5, failureClass: null, checkedAt: "t" },
    { modelId: "b", kind: "llm", status: "dead", latencyMs: null, failureClass: "not_found", checkedAt: "t" },
  ]),
}));

const { GET } = await import("../../src/app/api/providers/[id]/model-probes/route.js");

describe("model-probes list route", () => {
  it("returns probes for the connection scope", async () => {
    const res = await GET({}, { params: Promise.resolve({ id: "c1" }) });
    const data = await res.json();
    expect(data.probes).toHaveLength(2);
    expect(data.probes[1].status).toBe("dead");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `tests/`): `npx vitest run unit/model-probes-list-route.test.js`
Expected: FAIL — route missing.

- [ ] **Step 3: Write the route**

```javascript
// src/app/api/providers/[id]/model-probes/route.js
// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById, getProbesForScope } from "@/lib/db/index.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/index.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    const scopeKey = buildModelProbeScopeKey(connection);
    const probes = await getProbesForScope(connection.provider, scopeKey);
    return NextResponse.json({ probes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error listing model probes:", error);
    return NextResponse.json({ error: "Failed to list probes" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `tests/`): `npx vitest run unit/model-probes-list-route.test.js`
Expected: PASS.

- [ ] **Step 5: Load probes into page.js**

Add state + loader in page.js:

```javascript
  const [probeByModel, setProbeByModel] = useState(/** @type {Record<string,string>} */ ({}));

  const fetchProbes = useCallback(async () => {
    const activeConn = connections.find((c) => c.isActive !== false);
    if (!activeConn) return;
    try {
      const r = await fetch(`/api/providers/${activeConn.id}/model-probes`, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      const map = {};
      for (const p of data.probes || []) {
        map[p.modelId] = p.status === "ok" ? "ok" : p.status === "dead" ? "dead" : "retry";
      }
      setProbeByModel(map);
    } catch { /* ignore */ }
  }, [connections]);

  useEffect(() => { fetchProbes(); }, [fetchProbes]);
```

Call `fetchProbes()` inside the existing verify `onComplete` handler (so badges refresh after a run).

- [ ] **Step 6: Lint + test**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/page.js"` → 0 errors.
Run (from `tests/`): `npx vitest run unit/model-probes-list-route.test.js` → PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/providers/[id]/model-probes/route.js" "src/app/(dashboard)/dashboard/providers/[id]/page.js" tests/unit/model-probes-list-route.test.js
git commit -m "feat(verify): persistent probe badges loaded on page open

Assistant-model: Claude Code"
```

---

### Task 8: Per-model badge + current-batch highlight in ModelRow

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (pass `probeState` + `isTesting` to each ModelRow)

**Interfaces:**
- Consumes: `probeByModel` (Task 7) and `verifyStatus.perModel` (from status poll) in page.js.
- Produces: each ModelRow shows a badge: `ok` (green dot), `dead` (red), `retry` (amber), `testing` (spinner). The badge value = `perModel[canonicalId]` if a job is running and has that entry, else `probeByModel[canonicalId]`.

- [ ] **Step 1: Add a badge element to ModelRow**

In `ModelRow.js`, add a `probeState` prop (string|null) and render near the model id (match existing badge styling — reuse `Badge` from `@/shared/components` if the row already imports it; otherwise a small span):

```javascript
      {probeState && (
        probeState === "testing" ? (
          <span className="material-symbols-outlined animate-spin text-[14px] text-text-muted" title="Testing…">progress_activity</span>
        ) : (
          <span
            title={probeState === "ok" ? "Reachable" : probeState === "dead" ? "Unavailable (dead)" : "Retry later"}
            className={`inline-block h-2 w-2 rounded-full ${probeState === "ok" ? "bg-green-500" : probeState === "dead" ? "bg-red-500" : "bg-amber-500"}`}
          />
        )
      )}
```

Add `probeState: PropTypes.string` to ModelRow.propTypes.

- [ ] **Step 2: Compute + pass probeState in page.js**

Where page.js renders each ModelRow, compute (using the row's canonical id — the model list already has model ids; if a `canonicalModelId` helper is needed import it from `@/lib/model-probe/index.js`):

```javascript
              probeState={
                (verifyStatus?.status === "running" && verifyStatus?.perModel?.[model.id])
                  ? verifyStatus.perModel[model.id]
                  : probeByModel[model.id] || null
              }
```

(Use `model.id` — probe `modelId` stored is the canonical id; if the row id differs from canonical, wrap with `canonicalModelId(model.id, providerStorageAlias)`.)

- [ ] **Step 3: Lint**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js" "src/app/(dashboard)/dashboard/providers/[id]/page.js"`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js" "src/app/(dashboard)/dashboard/providers/[id]/page.js"
git commit -m "feat(verify): per-model probe badges + testing spinner

Assistant-model: Claude Code"
```

---

### Task 9: Model list filter (All / OK / Dead / Retry)

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (or the models-list render section / ModelsCard if that's where the list maps)

**Interfaces:**
- Consumes: `probeByModel` (Task 7).
- Produces: a filter control above the model list; filters visible rows by probe state. Default `all`.

- [ ] **Step 1: Add filter state + control**

```javascript
  const [modelFilter, setModelFilter] = useState("all"); // all | ok | dead | retry
```

Render a small segmented control above the model rows:

```javascript
      <div className="mb-2 flex gap-1 text-xs">
        {["all", "ok", "dead", "retry"].map((f) => (
          <button
            key={f}
            onClick={() => setModelFilter(f)}
            className={`rounded px-2 py-0.5 ${modelFilter === f ? "bg-primary text-white" : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"}`}
          >
            {f === "all" ? "All" : f === "ok" ? "OK" : f === "dead" ? "Dead" : "Retry"}
          </button>
        ))}
      </div>
```

- [ ] **Step 2: Apply the filter to the rendered model list**

Wrap the model array the list maps over:

```javascript
  const visibleModels = models.filter((m) => {
    if (modelFilter === "all") return true;
    return (probeByModel[m.id] || null) === modelFilter;
  });
```

Use `visibleModels` in the `.map(...)` that renders ModelRow (replace `models.map` / current source array in that render).

- [ ] **Step 3: Lint**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/page.js"`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/page.js"
git commit -m "feat(verify): filter model list by probe state

Assistant-model: Claude Code"
```

---

### Task 10: Import skips known-dead + auto-verify

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (`handleImportModels`)
- Reuse: `GET /api/providers/{id}/model-probes` (Task 7) for dead ids; `POST .../verify/start` for auto-verify.

**Interfaces:**
- Consumes: probe list route, verify/start route, `canonicalModelId` from `@/lib/model-probe/index.js`.
- Produces: import filters out dead candidates and reports `Y skipped (known dead)`; after a successful import, auto-starts verify.

- [ ] **Step 1: Import canonicalModelId in page.js**

Add to imports:

```javascript
import { canonicalModelId } from "@/lib/model-probe/index.js";
```

- [ ] **Step 2: Build the dead set before the candidate loop**

In `handleImportModels`, after `rawModels` is fetched and before the `for (const raw of rawModels)` loop, fetch dead ids for the active connection:

```javascript
      let deadSet = new Set();
      try {
        const pr = await fetch(`/api/providers/${activeConnection.id}/model-probes`, { cache: "no-store" });
        const pd = await pr.json().catch(() => ({}));
        for (const p of pd.probes || []) {
          if (p.status === "dead") deadSet.add(p.modelId);
        }
      } catch { /* no dead cache — import everything */ }
      let skippedDead = 0;
```

- [ ] **Step 3: Skip dead candidates in the loop**

Inside the loop, right after computing `const { id, name, type } = normalized;`, add:

```javascript
        if (deadSet.has(canonicalModelId(id, providerStorageAlias))) { skippedDead += 1; continue; }
```

- [ ] **Step 4: Report skipped + auto-verify**

In the results message block (where `parts` is assembled), append skipped count and trigger verify. After `setImportModelsMessage(...)` for the success branch, add:

```javascript
      if (skippedDead > 0) {
        setImportModelsMessage((prev) => `${prev} · ${skippedDead} skipped (known dead)`);
      }
      // Auto-verify the freshly imported list.
      if (added > 0) {
        try {
          const allModels = [...models, ...toAdd.map((m) => ({ id: m.id, name: m.name, kind: m.type }))];
          await fetch(`/api/providers/${activeConnection.id}/model-probes/verify/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models: allModels, providerAlias: providerStorageAlias }),
          });
        } catch { /* auto-verify best-effort */ }
      }
```

- [ ] **Step 5: Lint**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/page.js"`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/page.js"
git commit -m "feat(verify): import skips known-dead models + auto-verifies

Assistant-model: Claude Code"
```

---

### Task 11: Stat clarity in the panel (tooltips + unified wording)

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js`

**Interfaces:**
- Consumes: existing `progress` + `summary` state.
- Produces: clearer counters with `title` tooltips; consistent wording between progress line and summary.

- [ ] **Step 1: Update the progress line + summary with tooltips**

Replace the progress `<p>` (currently `{progress.done}/{progress.total} tested · ok ...`) with tooltipped spans:

```javascript
          <p className="text-[11px] text-text-muted flex flex-wrap gap-x-2">
            <span title="Models probed this run">{progress.done}/{progress.total} tested</span>
            <span title="Reachable">· ok {progress.ok}</span>
            <span title="Permanently unavailable this run (404 not found / 403 access denied)">· dead {progress.dead}</span>
            <span title="Transient failure this run (timeout / 429 / 5xx / network); re-testable">· retry {progress.retryable}</span>
            {progress.skippedDead ? <span title="Not probed — cache already marks them dead. Clear cache to re-test.">· skipped known-dead {progress.skippedDead}</span> : null}
            {progress.skippedDup ? <span title="Duplicate ids collapsed">· dupes {progress.skippedDup}</span> : null}
          </p>
```

Update the header helper text (line ~238) to match the taxonomy:

```javascript
            Batch-ping availability and latency. Dead = permanently unavailable (404/403) and can be removed;
            retry = transient (timeout/429/5xx). Known-dead models are skipped until you Clear cache. Caps: {capsLabel}.
```

Update the summary line to identical wording:

```javascript
          <span className="text-xs text-text-main">
            Summary: {summary.ok} ok · {summary.dead} dead · {summary.retryable} retry
            {summary.skippedDead ? ` · ${summary.skippedDead} skipped known-dead` : ""}
            {summary.cancelled ? " · cancelled" : ""}
          </span>
```

- [ ] **Step 2: Lint**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"
git commit -m "feat(verify): clearer, tooltipped verification counters

Assistant-model: Claude Code"
```

---

### Task 12: One-click remove-dead prominence (summary CTA)

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js`

**Interfaces:**
- Consumes: existing `handleRemoveUnavailable` (already POSTs `remove-unavailable`, which deletes only custom dead — wildcard/built-in untouched, matching the reversible policy).
- Produces: when `summary.dead > 0`, a prominent primary button `Remove {dead} dead` instead of the current secondary `Remove unavailable custom`.

- [ ] **Step 1: Make the remove button prominent + counted**

Replace the summary's remove `Button`:

```javascript
          {summary.dead > 0 && (
            <Button size="sm" variant="primary" icon="delete_sweep" onClick={handleRemoveUnavailable} disabled={running}>
              Remove {summary.dead} dead
            </Button>
          )}
```

(Only custom-model dead entries are hard-deleted by the route; wildcard/built-in catalog entries are left intact. This matches the spec's reversible-removal policy — no plan change needed to the route.)

- [ ] **Step 2: Lint**

Run: `npx eslint "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/dashboard/providers/[id]/VerifyModelsPanel.js"
git commit -m "feat(verify): prominent one-click remove-dead CTA

Assistant-model: Claude Code"
```

---

### Task 13: Boot the verify job module + full-suite gate

**Files:**
- Verify: `src/shared/services/initializeApp.js` (no new scheduler needed — the job is request-triggered, not tick-based; confirm no boot wiring is required).
- Run: full test suite + lint + version parity.

**Interfaces:** none new — this is the integration gate.

- [ ] **Step 1: Confirm no boot wiring needed**

The verify job is started on-demand by the `verify/start` route, not on a timer. Unlike `scheduler.js`, it needs no `initializeApp` entry. Confirm by reading `initializeApp.js` — do NOT add a `startVerify*` call. (Documented here so the implementer doesn't add dead boot code.)

- [ ] **Step 2: Run the full test suite**

Run (from `tests/`): `npx vitest run --reporter=dot`
Expected: all pass (0 failed; "expected fail" entries are fine). If root `node_modules` is missing, run `npm ci` at repo root first (sandbox off).

- [ ] **Step 3: Lint the whole repo**

Run (repo root): `npm run lint`
Expected: 0 errors (pre-existing gitbook warnings acceptable).

- [ ] **Step 4: Version parity check**

Run (repo root): `npm run check:versions`
Expected: "Release version ... committed consistently".

- [ ] **Step 5: Manual smoke (drive the app)**

With the dev server running: open a provider with many models, click "Verify models" → Start; confirm progress bar advances, toggle button shows `Verifying N/total`, navigate away and back → run still progressing, per-row badges appear, filter works, finish → `Remove N dead` button; run Import → confirm `skipped (known dead)` message + auto-verify kicks off.

- [ ] **Step 6: Commit any lint/parity fixups**

```bash
git add -A
git commit -m "chore(verify): integration gate — full suite + lint green

Assistant-model: Claude Code"
```

---

## Self-Review

**Spec coverage:**
- §1 job runner → Task 1, 2. §2 API → Task 3, 4, 7 (list route). §3 panel observer → Task 5. §4 toggle indicator → Task 6. §5 per-row state → Task 8. §6 persistent badge + filter → Task 7, 9. §7 one-click remove → Task 12. §8 import skip-dead + auto-verify → Task 10. §9 stat clarity → Task 11. Integration → Task 13. All covered.

**Placeholder scan:** No TBD/TODO; every code step shows full code. Manual-smoke step (13.5) is explicit steps, not a placeholder.

**Type consistency:** `snapshot` shape (perModel as Record) consistent across Task 1 (producer), Task 5/6/8 (consumers). `startVerify` signature identical in Task 1 def and Task 3/4/10 callers. `probeByModel`/`probeState` values `"ok"|"dead"|"retry"|"testing"` consistent across Tasks 7/8/9. Route params `{ params }` Promise-form matches existing routes (`await params`).

**Known follow-up:** row `model.id` vs canonical id — flagged inline in Task 8 Step 2 (wrap with `canonicalModelId` if they differ). Implementer resolves by checking the actual stored `modelId` during Task 8.
