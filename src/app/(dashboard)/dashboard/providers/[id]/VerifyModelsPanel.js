// @ts-check
"use client";

import { useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { MODEL_PROBE_CAPS } from "@/lib/model-probe/caps.js";

/**
 * Batch model verification UI: prepare → batched probes → summary/actions.
 *
 * @param {{
 *   connectionId: string,
 *   providerAlias: string,
 *   models: Array<{ id: string, name?: string, kind?: string, type?: string }>,
 *   onComplete?: (summary: object) => void,
 *   onLatencyMap?: (map: Record<string, number>) => void,
 *   onClose?: () => void,
 * }} props
 */
export default function VerifyModelsPanel({
  connectionId,
  providerAlias,
  models,
  onComplete,
  onLatencyMap,
  onClose,
}) {
  const [concurrency, setConcurrency] = useState(MODEL_PROBE_CAPS.defaultConcurrency);
  const [batchSize, setBatchSize] = useState(MODEL_PROBE_CAPS.defaultBatchSize);
  const [timeoutSec, setTimeoutSec] = useState(Math.round(MODEL_PROBE_CAPS.defaultTimeoutMs / 1000));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(/** @type {null|{ done: number, total: number, ok: number, dead: number, retryable: number, skippedDead: number, skippedDup: number }} */ (null));
  const [summary, setSummary] = useState(/** @type {null|Record<string, any>} */ (null));
  const [error, setError] = useState("");
  const [logLine, setLogLine] = useState("");
  const cancelRef = useRef(false);
  const abortRef = useRef(/** @type {AbortController|null} */ (null));

  const modelCount = models?.length || 0;
  const capsLabel = useMemo(
    () =>
      `max concurrency ${MODEL_PROBE_CAPS.maxConcurrency} · batch ${MODEL_PROBE_CAPS.maxBatchSize} · timeout ${MODEL_PROBE_CAPS.maxTimeoutMs / 1000}s`,
    [],
  );

  function clampLocal() {
    return {
      concurrency: Math.max(1, Math.min(MODEL_PROBE_CAPS.maxConcurrency, Number(concurrency) || MODEL_PROBE_CAPS.defaultConcurrency)),
      batchSize: Math.max(1, Math.min(MODEL_PROBE_CAPS.maxBatchSize, Number(batchSize) || MODEL_PROBE_CAPS.defaultBatchSize)),
      timeoutMs: Math.max(1000, Math.min(MODEL_PROBE_CAPS.maxTimeoutMs, (Number(timeoutSec) || 20) * 1000)),
    };
  }

  async function handleStart() {
    if (running || !connectionId || modelCount === 0) return;
    cancelRef.current = false;
    setRunning(true);
    setError("");
    setSummary(null);
    setLogLine("Preparing…");

    const opts = clampLocal();
    const latencyMap = {};

    try {
      const prepRes = await fetch(`/api/providers/${connectionId}/model-probes/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models,
          providerAlias,
          concurrency: opts.concurrency,
          batchSize: opts.batchSize,
          timeoutMs: opts.timeoutMs,
        }),
      });
      const prep = await prepRes.json().catch(() => ({}));
      if (!prepRes.ok) {
        setError(prep.error || "Prepare failed");
        return;
      }

      const eligible = prep.eligible || [];
      const skippedDead = prep.stats?.skippedDead || 0;
      const skippedDup = prep.stats?.duplicates || 0;

      setProgress({
        done: 0,
        total: eligible.length,
        ok: 0,
        dead: 0,
        retryable: 0,
        skippedDead,
        skippedDup,
      });

      if (eligible.length === 0) {
        const emptySummary = {
          ok: 0,
          dead: 0,
          retryable: 0,
          tested: 0,
          skippedDead,
          skippedDup,
          removed: 0,
        };
        setSummary(emptySummary);
        setLogLine("Nothing to test (all skipped as known-unavailable or empty).");
        onComplete?.(emptySummary);
        return;
      }

      let ok = 0;
      let dead = 0;
      let retryable = 0;
      let done = 0;

      for (let i = 0; i < eligible.length; i += opts.batchSize) {
        if (cancelRef.current) break;
        const chunk = eligible.slice(i, i + opts.batchSize);
        setLogLine(`Probing ${done + 1}–${Math.min(done + chunk.length, eligible.length)} of ${eligible.length}…`);

        abortRef.current = new AbortController();
        const batchRes = await fetch(`/api/providers/${connectionId}/model-probes/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortRef.current.signal,
          body: JSON.stringify({
            models: chunk,
            providerAlias,
            concurrency: opts.concurrency,
            batchSize: opts.batchSize,
            timeoutMs: opts.timeoutMs,
            warmup: i === 0,
          }),
        });
        const batch = await batchRes.json().catch(() => ({}));
        if (batch.providerError) {
          setError(batch.error || "Provider authentication failed");
          break;
        }
        if (!batchRes.ok) {
          setError(batch.error || "Batch failed");
          break;
        }

        for (const r of batch.results || []) {
          if (r.probeStatus === "ok") {
            ok += 1;
            if (r.modelId && Number.isFinite(r.latencyMs)) latencyMap[r.modelId] = r.latencyMs;
            if (r.canonicalId && Number.isFinite(r.latencyMs)) latencyMap[r.canonicalId] = r.latencyMs;
          } else if (r.probeStatus === "dead") dead += 1;
          else retryable += 1;
        }
        done += (batch.results || []).length;
        setProgress({
          done,
          total: eligible.length,
          ok,
          dead,
          retryable,
          skippedDead,
          skippedDup,
        });
      }

      onLatencyMap?.(latencyMap);
      const finalSummary = {
        ok,
        dead,
        retryable,
        tested: done,
        skippedDead,
        skippedDup,
        cancelled: cancelRef.current,
      };
      setSummary(finalSummary);
      setLogLine(cancelRef.current ? "Cancelled (partial results saved)." : "Done.");
      onComplete?.(finalSummary);
    } catch (e) {
      if (e?.name === "AbortError") {
        setLogLine("Cancelled.");
      } else {
        setError(e?.message || "Verify failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    cancelRef.current = true;
    abortRef.current?.abort();
  }

  async function handleRemoveUnavailable() {
    if (!connectionId) return;
    setLogLine("Removing unavailable custom models…");
    const res = await fetch(`/api/providers/${connectionId}/model-probes/remove-unavailable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerAlias, kind: "llm" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Remove failed");
      return;
    }
    setLogLine(`Removed ${data.removed || 0} unavailable custom model(s).`);
    onComplete?.({ ...(summary || {}), removed: data.removed || 0 });
  }

  async function handleClearCache() {
    if (!connectionId) return;
    const res = await fetch(`/api/providers/${connectionId}/model-probes/cache`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Clear cache failed");
      return;
    }
    setLogLine(`Cleared probe cache (${data.cleared || 0} rows). Next verify will re-test everything.`);
    setSummary(null);
    setProgress(null);
  }

  const pct = progress?.total
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;

  return (
    <div className="mb-4 rounded-lg border border-border bg-sidebar/40 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Verify models</h3>
          <p className="text-[11px] text-text-muted mt-0.5">
            Batch-ping availability and latency. Known-dead models are skipped until you clear the cache.
            Caps: {capsLabel}.
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="p-1 text-text-muted hover:text-text-main rounded">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-xs text-text-muted">
          Concurrency
          <input
            type="number"
            min={1}
            max={MODEL_PROBE_CAPS.maxConcurrency}
            value={concurrency}
            disabled={running}
            onChange={(e) => setConcurrency(e.target.value)}
            className="mt-1 block w-20 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <label className="text-xs text-text-muted">
          Batch size
          <input
            type="number"
            min={1}
            max={MODEL_PROBE_CAPS.maxBatchSize}
            value={batchSize}
            disabled={running}
            onChange={(e) => setBatchSize(e.target.value)}
            className="mt-1 block w-20 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <label className="text-xs text-text-muted">
          Timeout (s)
          <input
            type="number"
            min={1}
            max={MODEL_PROBE_CAPS.maxTimeoutMs / 1000}
            value={timeoutSec}
            disabled={running}
            onChange={(e) => setTimeoutSec(e.target.value)}
            className="mt-1 block w-20 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <div className="flex gap-2">
          {!running ? (
            <Button size="sm" icon="science" onClick={handleStart} disabled={!connectionId || modelCount === 0}>
              Start
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon="stop" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="secondary" icon="delete_sweep" onClick={handleClearCache} disabled={running}>
            Clear cache
          </Button>
        </div>
      </div>

      {progress && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-text-muted">
            {progress.done}/{progress.total} tested · ok {progress.ok} · dead {progress.dead} · retry {progress.retryable}
            {progress.skippedDead ? ` · skipped dead ${progress.skippedDead}` : ""}
            {progress.skippedDup ? ` · dupes ${progress.skippedDup}` : ""}
          </p>
        </div>
      )}

      {logLine && <p className="text-xs text-text-muted">{logLine}</p>}
      {error && <p className="text-xs text-red-500 break-words">{error}</p>}

      {summary && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-text-main">
            Summary: {summary.ok} ok · {summary.dead} unavailable · {summary.retryable} retry later
            {summary.skippedDead ? ` · ${summary.skippedDead} skipped (known dead)` : ""}
            {summary.cancelled ? " · cancelled" : ""}
          </span>
          {summary.dead > 0 && (
            <Button size="sm" variant="secondary" icon="delete" onClick={handleRemoveUnavailable} disabled={running}>
              Remove unavailable custom
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

VerifyModelsPanel.propTypes = {
  connectionId: PropTypes.string,
  providerAlias: PropTypes.string,
  models: PropTypes.arrayOf(PropTypes.object),
  onComplete: PropTypes.func,
  onLatencyMap: PropTypes.func,
  onClose: PropTypes.func,
};
