"use client";
// @ts-check

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, Button } from "@/shared/components";

/**
 * Routing Insights for Auto combos (docs/switchboard/DASHBOARD.md).
 * Query: ?combo=name
 */
export default function RoutingInsightsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-text-muted p-4">Loading insights…</p>}>
      <RoutingInsightsInner />
    </Suspense>
  );
}

function RoutingInsightsInner() {
  const searchParams = useSearchParams();
  const combo = searchParams.get("combo") || "";
  const [data, setData] = useState(/** @type {any} */ (null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [learnMsg, setLearnMsg] = useState("");
  const [days, setDays] = useState(14);
  const [cluster, setCluster] = useState("");
  const [worker, setWorker] = useState("");
  const [explorationOnly, setExplorationOnly] = useState(false);

  const load = useCallback(async () => {
    if (!combo) return;
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({
        combo,
        days: String(days),
      });
      if (cluster) qs.set("cluster", cluster);
      if (worker) qs.set("worker", worker);
      if (explorationOnly) qs.set("exploration", "1");
      const r = await fetch(`/api/routing/insights?${qs}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load insights");
      setData(j);
    } catch (e) {
      setError(e.message || "Failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [combo, days, cluster, worker, explorationOnly]);

  useEffect(() => {
    load();
  }, [load]);

  // Optional user feedback thumbs (Auto v2). Feeds the same ±25 slot the judge
  // uses; an explicit rating overrides a judge adjustment on the same event.
  const sendFeedback = useCallback(
    async (requestId, rating) => {
      if (!requestId) return;
      try {
        const r = await fetch("/api/routing/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, rating }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Feedback failed");
        setLearnMsg(rating === 0 ? "Feedback cleared" : "Thanks — feedback recorded");
        await load();
      } catch (e) {
        setLearnMsg(e.message || "Feedback failed");
      }
    },
    [load]
  );

  const maxAvg = useMemo(() => {
    if (!data?.heatmap) return 100;
    let m = 1;
    for (const row of data.heatmap) {
      for (const c of row.cells || []) {
        if (c.avg != null && c.avg > m) m = c.avg;
      }
    }
    return m;
  }, [data]);

  if (!combo) {
    return (
      <div className="max-w-lg space-y-3">
        <h1 className="text-[17px] font-semibold">Routing insights</h1>
        <p className="text-sm text-text-muted">
          Open from a combo card with strategy <strong>Auto</strong>, or append{" "}
          <code className="text-xs">?combo=your-combo</code>.
        </p>
        <Link href="/dashboard/combos" className="text-sm text-primary hover:underline">
          ← Combos
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 max-w-[1180px]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[17px] font-semibold tracking-tight">Routing insights</h1>
          <p className="text-xs font-mono text-text-subtle">
            combo: {combo}
            {data?.strategy?.routerModel
              ? ` · router ${data.strategy.routerModel}`
              : ""}
            {data?.strategy?.objective ? ` · ${data.strategy.objective}` : ""}
            {data?.strategy?.explorationRate != null
              ? ` · ε=${Math.round((data.strategy.explorationRate ?? 0.05) * 100)}% (cap ${Math.round((data.strategy.explorationRateCap ?? 0.2) * 100)}%)`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 14)}
            className="text-[11.5px] font-mono text-text-subtle px-2 py-1.5 rounded-[7px] bg-surface-2 border border-border"
            title="Date range"
          >
            <option value={7}>last 7 days</option>
            <option value={14}>last 14 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
          </select>
          <select
            value={cluster}
            onChange={(e) => setCluster(e.target.value)}
            className="text-[11.5px] font-mono text-text-subtle px-2 py-1.5 rounded-[7px] bg-surface-2 border border-border max-w-[140px]"
            title="Filter cluster"
          >
            <option value="">all clusters</option>
            {(data?.clusters || []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={worker}
            onChange={(e) => setWorker(e.target.value)}
            className="text-[11.5px] font-mono text-text-subtle px-2 py-1.5 rounded-[7px] bg-surface-2 border border-border max-w-[160px]"
            title="Filter worker"
          >
            <option value="">all workers</option>
            {(data?.workers || []).map((w) => (
              <option key={w} value={w}>{w.split("/").pop()}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1 text-[11px] text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={explorationOnly}
              onChange={(e) => setExplorationOnly(e.target.checked)}
            />
            exploration only
          </label>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            Refresh
          </Button>
          <Button
            size="sm"
            disabled={loading}
            onClick={async () => {
              setLearnMsg("");
              try {
                const r = await fetch("/api/routing/learn", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ comboName: combo }),
                });
                const j = await r.json();
                setLearnMsg(j.message || JSON.stringify(j));
                await load();
              } catch (e) {
                setLearnMsg(e.message);
              }
            }}
          >
            Relearn now
          </Button>
          <Link
            href="/dashboard/combos"
            className="text-xs text-text-muted hover:text-primary px-2 py-1.5"
          >
            ← Combos
          </Link>
        </div>
      </div>

      {learnMsg && (
        <p className="text-xs font-mono text-text-subtle">{learnMsg}</p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && !data && (
        <p className="text-sm text-text-muted">Loading…</p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Requests" value={String(data.eventCount ?? 0)} />
            <Stat
              label="Need for learn"
              value={
                data.needMore > 0
                  ? `${data.needMore} more`
                  : "ready"
              }
            />
            <Stat
              label="Active version"
              value={
                data.promoted
                  ? `v${data.promoted.version}`
                  : "—"
              }
            />
            <Stat
              label="Eval score"
              value={
                data.promoted?.evalScore != null
                  ? Number(data.promoted.evalScore).toFixed(1)
                  : "—"
              }
            />
          </div>
          <p className="text-[11px] text-text-subtle font-mono -mt-2">
            Request-level counts (one per chat). Intermediate fallback attempts
            {data.attemptCount != null && data.attemptCount !== data.eventCount
              ? ` (${data.attemptCount} attempt rows)`
              : ""}{" "}
            feed the bandit but not the min-events gate. Single-worker and
            heuristic shortcuts are not logged here.
          </p>

          <Card padding="md">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <span className="text-[13px] font-semibold">Win-rate heatmap</span>
              <div className="flex items-center gap-2 text-[10.5px] font-mono text-text-subtle">
                <span>low</span>
                <span
                  className="w-[120px] h-2 rounded"
                  style={{
                    background:
                      "linear-gradient(90deg,rgba(229,180,84,.1),rgba(229,180,84,.72))",
                  }}
                />
                <span>high · number always shown</span>
              </div>
            </div>
            <p className="text-[11.5px] font-mono text-text-subtle mb-3">
              cluster × worker · average outcome score (0–100)
            </p>
            {data.clusters?.length && data.workers?.length ? (
              <div
                className="grid gap-1 overflow-x-auto"
                style={{
                  gridTemplateColumns: `112px repeat(${data.workers.length}, minmax(56px, 1fr))`,
                }}
              >
                <div />
                {data.workers.map((w) => (
                  <div
                    key={w}
                    className="font-mono text-[10.5px] text-text-muted text-center pb-1 truncate"
                    title={w}
                  >
                    {w.split("/").pop()}
                  </div>
                ))}
                {data.heatmap.map((row) => (
                  <div key={row.cluster} className="contents">
                    <div className="text-[11px] uppercase tracking-wide text-text-muted flex items-center font-medium">
                      {row.cluster}
                    </div>
                    {row.cells.map((c) => {
                      const avg = c.avg;
                      const intensity =
                        avg == null || maxAvg <= 0 ? 0 : Math.min(1, avg / maxAvg);
                      return (
                        <div
                          key={`${row.cluster}-${c.worker}`}
                          className="rounded text-center font-mono text-[11px] py-2 border border-border"
                          style={{
                            background: `rgba(229,180,84,${0.08 + intensity * 0.55})`,
                            color: avg == null ? "#6F6653" : "#ECE4D2",
                          }}
                          title={`${c.worker}: n=${c.n}`}
                        >
                          {avg == null ? "—" : Math.round(avg)}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted py-6 text-center">
                No routing events yet. Point a client at this combo with strategy Auto.
              </p>
            )}
          </Card>

          <Card padding="md">
            <span className="text-[13px] font-semibold">Score trend</span>
            <p className="text-[11px] text-text-subtle font-mono mb-2">
              mean outcomeScore per day over the selected window (request-level)
            </p>
            {(data.scoreTrend || []).length === 0 ? (
              <p className="text-xs text-text-muted py-3 text-center">No scored days yet</p>
            ) : (
              <div className="flex items-end gap-1 h-24 overflow-x-auto pt-2">
                {(() => {
                  const trend = data.scoreTrend || [];
                  const maxS = Math.max(
                    1,
                    ...trend.map((d) => Number(d.avgScore) || 0)
                  );
                  return trend.map((d) => {
                    const avg = Number(d.avgScore) || 0;
                    const h = Math.max(4, Math.round((avg / maxS) * 80));
                    return (
                      <div
                        key={d.day}
                        className="flex flex-col items-center gap-0.5 min-w-[28px]"
                        title={`${d.day}: ${avg.toFixed(1)} (n=${d.n})`}
                      >
                        <span className="text-[9px] font-mono text-text-subtle">
                          {Math.round(avg)}
                        </span>
                        <div
                          className="w-5 rounded-t bg-primary/70"
                          style={{ height: h }}
                        />
                        <span className="text-[8px] font-mono text-text-subtle">
                          {String(d.day).slice(5)}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card padding="md">
              <span className="text-[13px] font-semibold">Model performance</span>
              <div className="mt-3 space-y-2">
                {(data.modelStats || []).length === 0 && (
                  <p className="text-xs text-text-muted">No data</p>
                )}
                {(data.modelStats || []).map((m) => (
                  <div
                    key={m.worker}
                    className="grid grid-cols-[1fr_52px_60px_40px] gap-2 items-center text-xs"
                  >
                    <span className="font-mono truncate text-text-main" title={m.worker}>
                      {m.worker}
                    </span>
                    <span className="text-right font-mono text-text-muted">
                      {m.avgScore != null ? Math.round(m.avgScore) : "—"}
                    </span>
                    <span className="text-right font-mono text-text-muted">
                      {m.avgLatencyMs != null ? `${Math.round(m.avgLatencyMs)}ms` : "—"}
                    </span>
                    <span className="text-right font-mono text-text-subtle">{m.errors || 0}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card padding="md">
              <span className="text-[13px] font-semibold">Learning versions</span>
              <p className="text-[11px] text-text-subtle font-mono mb-2">
                immutable · rollback-safe
              </p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {(data.versions || []).length === 0 && (
                  <p className="text-xs text-text-muted">No versions yet</p>
                )}
                {(data.versions || []).map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between gap-2 text-xs border-b border-border py-1.5"
                  >
                    <div>
                      <span className="font-mono text-text-main">
                        v{v.version}
                        {v.promoted ? " · active" : ""}
                      </span>
                      <div className="text-[10px] text-text-subtle font-mono">
                        eval {v.evalScore != null ? Number(v.evalScore).toFixed(1) : "—"} ·{" "}
                        {v.source}
                      </div>
                    </div>
                    {!v.promoted && (
                      <button
                        type="button"
                        className="text-primary text-[11px] hover:underline"
                        onClick={async () => {
                          await fetch("/api/routing/versions/promote", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: v.id }),
                          });
                          load();
                        }}
                      >
                        Promote
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {data.promoted?.prevVersionId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={async () => {
                    await fetch("/api/routing/versions/rollback", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ comboName: combo }),
                    });
                    load();
                  }}
                >
                  Rollback
                </Button>
              )}
            </Card>
          </div>

          <Card padding="md">
            <span className="text-[13px] font-semibold">Recent decisions</span>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-text-subtle font-mono uppercase tracking-wide">
                  <tr>
                    <th className="py-1 pr-2">Time</th>
                    <th className="py-1 pr-2">Cluster</th>
                    <th className="py-1 pr-2">Worker</th>
                    <th className="py-1 pr-2">Score</th>
                    <th className="py-1 pr-2">Reason</th>
                    <th className="py-1">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.recent || []).map((e) => {
                    const rating = e.meta?.userRating ?? null;
                    return (
                    <tr key={e.id} className="border-t border-border">
                      <td className="py-1.5 pr-2 font-mono text-text-muted whitespace-nowrap">
                        {e.timestamp?.slice(0, 19)?.replace("T", " ")}
                        {e.meta?.exploration ? (
                          <span className="ml-1 text-[9px] text-primary">ε</span>
                        ) : null}
                        {e.meta?.judgeScore != null ? (
                          <span
                            className="ml-1 text-[9px] text-text-subtle"
                            title={`LLM-judge score ${e.meta.judgeScore}/10`}
                          >
                            J{e.meta.judgeScore}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2">{e.cluster || "—"}</td>
                      <td className="py-1.5 pr-2 font-mono truncate max-w-[160px]" title={e.pickedWorker}>
                        {e.pickedWorker?.split("/").pop() || "—"}
                      </td>
                      <td className="py-1.5 pr-2 font-mono">
                        {e.outcomeScore != null ? Math.round(e.outcomeScore) : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-text-muted truncate max-w-[240px]" title={e.routerReason}>
                        {e.routerReason || "—"}
                      </td>
                      <td className="py-1.5 whitespace-nowrap">
                        {e.requestId ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              title="Good route"
                              className={`text-[13px] leading-none ${rating === 1 ? "text-primary" : "text-text-subtle hover:text-primary"}`}
                              onClick={() => sendFeedback(e.requestId, rating === 1 ? 0 : 1)}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              title="Bad route"
                              className={`text-[13px] leading-none ${rating === -1 ? "text-red-400" : "text-text-subtle hover:text-red-400"}`}
                              onClick={() => sendFeedback(e.requestId, rating === -1 ? 0 : -1)}
                            >
                              ▼
                            </button>
                          </span>
                        ) : (
                          <span className="text-[10px] text-text-subtle">—</span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {!(data.recent || []).length && (
                <p className="text-xs text-text-muted py-4 text-center">No decisions logged</p>
              )}
            </div>
          </Card>

          <Card padding="md">
            <span className="text-[13px] font-semibold">Exploration log</span>
            <p className="text-[11px] text-text-subtle font-mono mb-2">
              epsilon-greedy random picks (meta.exploration)
            </p>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {(data.explorationLog || []).length === 0 && (
                <p className="text-xs text-text-muted">No exploration events in this window</p>
              )}
              {(data.explorationLog || []).map((e) => (
                <div
                  key={`ex-${e.id}`}
                  className="flex flex-wrap gap-2 text-[11px] font-mono border-b border-border py-1"
                >
                  <span className="text-text-muted">
                    {e.timestamp?.slice(0, 19)?.replace("T", " ")}
                  </span>
                  <span>{e.cluster || "—"}</span>
                  <span className="text-primary">{e.pickedWorker?.split("/").pop()}</span>
                  <span className="text-text-subtle">
                    score {e.outcomeScore != null ? Math.round(e.outcomeScore) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-[11px] border border-border bg-surface p-3.5">
      <div className="text-[10px] uppercase tracking-wide text-text-subtle mb-1.5">
        {label}
      </div>
      <div className="font-mono text-[18px] font-semibold text-text-main">{value}</div>
    </div>
  );
}
