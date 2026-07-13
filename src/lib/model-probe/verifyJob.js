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
  };
  g.jobs.set(connectionId, placeholderJob);

  const probes = await getProbesForScope(providerId, scopeKey);
  const prep = prepareProbeModels({ models, probes, providerAlias });
  const eligible = prep.eligible;

  // Fill in the real fields on the same job object that's already in the map.
  const job = placeholderJob;
  job.total = eligible.length;
  job.skippedDead = prep.stats.skippedDead;
  job.skippedDup = prep.stats.duplicates;

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
