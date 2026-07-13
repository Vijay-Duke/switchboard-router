// @ts-check
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { MODEL_PROBE_CAPS } from "@/lib/model-probe/caps.js";

/**
 * Batch model verification UI: post start job → poll status → summary/actions.
 *
 * @param {{
 *   connectionId: string,
 *   providerAlias: string,
 *   models: Array<{ id: string, name?: string, kind?: string, type?: string }>,
 *   onComplete?: (summary: object) => void,
 *   onLatencyMap?: (map: Record<string, number>) => void,
 *   onClose?: () => void,
 *   pollMs?: number,
 * }} props
 */
export default function VerifyModelsPanel({
  connectionId,
  providerAlias,
  models,
  onComplete,
  onLatencyMap,
  onClose,
  pollMs = 1000,
}) {
  const [concurrency, setConcurrency] = useState(MODEL_PROBE_CAPS.defaultConcurrency);
  const [batchSize, setBatchSize] = useState(MODEL_PROBE_CAPS.defaultBatchSize);
  const [timeoutSec, setTimeoutSec] = useState(Math.round(MODEL_PROBE_CAPS.defaultTimeoutMs / 1000));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(/** @type {null|{ done: number, total: number, ok: number, dead: number, retryable: number, skippedDead: number, skippedDup: number }} */ (null));
  const [summary, setSummary] = useState(/** @type {null|Record<string, any>} */ (null));
  const [error, setError] = useState("");
  const [logLine, setLogLine] = useState("");
  const pollRef = useRef(/** @type {any} */ (null));
  const cbRef = useRef({ onComplete, onLatencyMap });

  const modelCount = models?.length || 0;
  const capsLabel = useMemo(
    () =>
      `max concurrency ${MODEL_PROBE_CAPS.maxConcurrency} · batch ${MODEL_PROBE_CAPS.maxBatchSize} · timeout ${MODEL_PROBE_CAPS.maxTimeoutMs / 1000}s`,
    [],
  );

  // Keep callbacks current to avoid stale closures in interval callbacks
  useEffect(() => {
    cbRef.current = { onComplete, onLatencyMap };
  });

  function clampLocal() {
    return {
      concurrency: Math.max(1, Math.min(MODEL_PROBE_CAPS.maxConcurrency, Number(concurrency) || MODEL_PROBE_CAPS.defaultConcurrency)),
      batchSize: Math.max(1, Math.min(MODEL_PROBE_CAPS.maxBatchSize, Number(batchSize) || MODEL_PROBE_CAPS.defaultBatchSize)),
      timeoutMs: Math.max(1000, Math.min(MODEL_PROBE_CAPS.maxTimeoutMs, (Number(timeoutSec) || 20) * 1000)),
    };
  }

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
      cbRef.current.onComplete?.(finalSummary);
      // Latency map is derived by the parent from the probe cache reload; no per-run map needed.
      cbRef.current.onLatencyMap?.({});
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
      if (snap.status === "running") startPolling();
      else setRunning(false);
    } catch (e) {
      setError(e?.message || "Verify failed");
      setRunning(false);
    }
  }

  async function handleCancel() {
    await fetch(`/api/providers/${connectionId}/model-probes/verify/cancel`, { method: "POST" }).catch(() => {});
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
            Batch-ping availability and latency. Dead = permanently unavailable (404/403) and can be removed;
            retry = transient (timeout/429/5xx). Known-dead models are skipped until you Clear cache. Caps: {capsLabel}.
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
          <p className="text-[11px] text-text-muted flex flex-wrap gap-x-2">
            <span title="Models probed this run">{progress.done}/{progress.total} tested</span>
            <span title="Reachable">· ok {progress.ok}</span>
            <span title="Permanently unavailable this run (404 not found / 403 access denied)">· dead {progress.dead}</span>
            <span title="Transient failure this run (timeout / 429 / 5xx / network); re-testable">· retry {progress.retryable}</span>
            {progress.skippedDead ? <span title="Not probed — cache already marks them dead. Clear cache to re-test.">· skipped known-dead {progress.skippedDead}</span> : null}
            {progress.skippedDup ? <span title="Duplicate ids collapsed">· dupes {progress.skippedDup}</span> : null}
          </p>
        </div>
      )}

      {logLine && <p className="text-xs text-text-muted">{logLine}</p>}
      {error && <p className="text-xs text-red-500 break-words">{error}</p>}

      {summary && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-text-main">
            Summary: {summary.ok} ok · {summary.dead} dead · {summary.retryable} retry
            {summary.skippedDead ? ` · ${summary.skippedDead} skipped known-dead` : ""}
            {summary.cancelled ? " · cancelled" : ""}
          </span>
          {summary.dead > 0 && (
            <Button size="sm" variant="primary" icon="delete_sweep" onClick={handleRemoveUnavailable} disabled={running}>
              Remove {summary.dead} dead
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
  pollMs: PropTypes.number,
};
