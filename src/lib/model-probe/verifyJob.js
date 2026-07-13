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
  job.abortController?.abort(new Error("Verification cancelled"));
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

  // Reserve the slot synchronously with a placeholder job BEFORE any await.
  // This prevents concurrent calls from both passing the guard and starting two loops.
  const placeholderJob = {
    connectionId, scopeKey, providerAlias,
    status: "running",
    total: 0,
    done: 0, ok: 0, dead: 0, retryable: 0,
    skippedDead: 0,
    skippedDup: 0,
    currentRange: null,
    perModel: {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    cancel: false,
    abortController: new AbortController(),
  };
  g.jobs.set(connectionId, placeholderJob);

  // Prep phase: if either of these throws, mark job error so the overlap guard
  // doesn't permanently block future startVerify calls for this connectionId.
  let probes, prep, eligible;
  try {
    probes = await getProbesForScope(providerId, scopeKey);
    prep = prepareProbeModels({ models, probes, providerAlias });
    eligible = prep.eligible;
  } catch (e) {
    placeholderJob.status = "error";
    placeholderJob.error = e?.message || String(e);
    placeholderJob.finishedAt = new Date().toISOString();
    return snapshot(placeholderJob);
  }

  // Fill in the real fields on the same job object that's already in the map.
  const job = placeholderJob;
  job.total = eligible.length;
  job.skippedDead = prep.stats.skippedDead;
  job.skippedDup = prep.stats.duplicates;
  const recorded = new Set();

  const recordResult = async (result) => {
    const key = `${result.kind || "llm"}|${result.canonicalId}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    if (upsertProbeResult) {
      await upsertProbeResult({
        providerId, scopeKey, modelId: result.canonicalId, kind: result.kind,
        status: result.probeStatus, latencyMs: result.latencyMs,
        failureClass: result.failureClass, failureMessage: result.failureMessage, checkedAt: result.checkedAt,
      });
    }
    if (result.probeStatus === "ok") { job.ok += 1; job.perModel[result.canonicalId] = "ok"; }
    else if (result.probeStatus === "dead") { job.dead += 1; job.perModel[result.canonicalId] = "dead"; }
    else { job.retryable += 1; job.perModel[result.canonicalId] = "retry"; }
    job.done += 1;
  };

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
          connectionId,
          signal: job.abortController.signal,
          onResult: recordResult,
        });

        // Injected/legacy batch runners may not implement onResult yet. Record
        // their returned results here; recordResult is idempotent.
        await Promise.all(results.map(recordResult));
        if (job.cancel) { job.status = "cancelled"; break; }

        // The batch was still executed, so persist and count its results before
        // stopping. Otherwise the UI reports 0 tested and leaves every row in
        // "testing" even though the provider returned an auth failure for each.
        const authFailure = results.length > 0 && results.every((r) => r.failureClass === "auth");
        if (authFailure) {
          job.status = "error";
          job.error = "Provider authentication failed for every probed model. Check this connection before retrying.";
          break;
        }
      }
      if (job.status === "running") job.status = "done";
    } catch (e) {
      if (job.cancel || job.abortController.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = e?.message || String(e);
      }
    } finally {
      job.currentRange = null;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return snapshot(job);
}
