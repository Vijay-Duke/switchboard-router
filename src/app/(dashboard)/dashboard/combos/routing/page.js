"use client";
// @ts-check

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, Button } from "@/shared/components";

const SERIES_COLORS = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#008300", "#e66767"];
const OTHER_COLOR = "#8a8172";
const PICK_SOURCES = [
  { key: "router", label: "Router" },
  { key: "bandit_policy", label: "Bandit policy" },
  { key: "cached_route", label: "Cached route" },
  { key: "exploration", label: "Exploration" },
  { key: "judge_flag_escalation", label: "Judge escalation" },
  { key: "fallback_rescue", label: "Fallback rescue" },
];
const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  color: "var(--color-text)",
  fontSize: "12px",
};

function buildWorkerColors(workers) {
  const sorted = [...new Set(workers)].sort();
  const map = {};
  sorted.forEach((w, i) => {
    map[w] = i < 6 ? SERIES_COLORS[i] : OTHER_COLOR;
  });
  return map;
}

function WorkerTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const model = payload[0].payload;
  return (
    <div className="font-mono" style={TOOLTIP_STYLE}>
      <p className="mb-1 text-text-muted">{model.worker}</p>
      <p className="text-text-main">Score: {Math.round(Number(model.avgScore) || 0)}</p>
      {model.winRate != null && (
        <p className="text-text-main">Win rate: {Math.round(model.winRate * 100)}%</p>
      )}
      <p className="text-text-main">Latency: {Math.round(Number(model.avgLatencyMs) || 0)}ms</p>
    </div>
  );
}

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
  const [stats, setStats] = useState(/** @type {any} */ (null));
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
      const [r, statsResponse] = await Promise.all([
        fetch(`/api/routing/insights?${qs}`, { cache: "no-store" }),
        fetch(`/api/routing/stats?combo=${encodeURIComponent(combo)}&days=${days}`, {
          cache: "no-store",
        })
          .then(async (response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load insights");
      setData(j);
      setStats(statsResponse);
    } catch (e) {
      setError(e.message || "Failed");
      setData(null);
      setStats(null);
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

  const timeline = stats?.timeline || [];
  const workerNames = [
    ...(data?.modelStats || []).map((model) => model.worker),
    ...timeline.map((row) => row.worker),
  ].filter(Boolean);
  const workerColors = buildWorkerColors(workerNames);
  const workerComparison = (data?.modelStats || []).map((model) => ({
    ...model,
    workerLabel: model.worker.split("/").pop(),
    winRate:
      model.wins != null && Number(model.n) > 0 ? Number(model.wins) / Number(model.n) : null,
  }));
  const timelineWorkers = [...new Set(timeline.map((row) => row.worker).filter(Boolean))].sort();
  const trendWorkers = timelineWorkers.filter((workerName) => workerColors[workerName] !== OTHER_COLOR);
  const hasOtherTrendWorkers = timelineWorkers.some(
    (workerName) => workerColors[workerName] === OTHER_COLOR
  );
  const trendByDay = new Map();
  for (const row of timeline) {
    const score = Number(row.avgScore);
    if (!Number.isFinite(score)) continue;
    const day = trendByDay.get(row.day) || { day: row.day, otherN: 0, otherScore: 0 };
    if (workerColors[row.worker] === OTHER_COLOR) {
      const n = Number(row.n) || 0;
      day.otherN += n;
      day.otherScore += score * n;
    } else {
      day[row.worker] = score;
    }
    trendByDay.set(row.day, day);
  }
  const trendData = [...trendByDay.values()].map((row) => {
    if (row.otherN > 0) row.Other = row.otherScore / row.otherN;
    delete row.otherN;
    delete row.otherScore;
    return row;
  });
  const displayedTrendWorkers = hasOtherTrendWorkers
    ? [...trendWorkers, "Other"]
    : trendWorkers;
  const pickSource = stats?.pickSource || {};
  const totalPicks = Object.values(pickSource).reduce(
    (total, value) => total + (Number(value) || 0),
    0
  );
  const routerSkip = totalPicks
    ? Math.round(
        (((Number(pickSource.bandit_policy) || 0) + (Number(pickSource.cached_route) || 0)) /
          totalPicks) *
          100
      )
    : null;
  const timelineSampleCount = timeline.reduce((total, row) => total + (Number(row.n) || 0), 0);
  const weightedScore = timeline.reduce(
    (total, row) => total + (Number(row.avgScore) || 0) * (Number(row.n) || 0),
    0
  );
  const judgeCoverage = stats?.judgeCoverage;
  const judgeCoveragePercent = judgeCoverage?.total
    ? Math.round((Number(judgeCoverage.judged) / Number(judgeCoverage.total)) * 100)
    : null;

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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Router-skip %" value={routerSkip == null ? "—" : `${routerSkip}%`} />
            <Stat
              label="Avg score"
              value={
                timelineSampleCount > 0 ? (weightedScore / timelineSampleCount).toFixed(1) : "—"
              }
            />
            <Stat
              label="Judge coverage %"
              value={judgeCoveragePercent == null ? "—" : `${judgeCoveragePercent}%`}
            />
            <Stat label="Total picks" value={String(totalPicks)} />
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
              mean outcome score per worker per day (request-level)
            </p>
            {trendData.length === 0 ? (
              <p className="text-xs text-text-muted py-6 text-center">
                No routing data in this window — Auto combos learn as they route
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
                  <XAxis
                    dataKey="day"
                    tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                    tickFormatter={(day) => String(day).slice(5)}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={32}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    itemStyle={{ color: "var(--color-text)" }}
                    labelStyle={{ color: "var(--color-text-muted)" }}
                    formatter={(value, name) => [Math.round(Number(value)), name]}
                  />
                  {displayedTrendWorkers.length >= 2 && (
                    <Legend
                      formatter={(value) => (
                        <span className="font-mono text-[10px] text-text-muted">{value}</span>
                      )}
                    />
                  )}
                  {displayedTrendWorkers.map((workerName) => (
                    <Line
                      key={workerName}
                      type="monotone"
                      /* Function dataKey: recharts string dataKeys are lodash paths,
                         so a model id with a dot (e.g. gemini-2.5-flash) would be
                         mis-parsed as a nested path and render an empty line. */
                      dataKey={(entry) => entry[workerName] ?? null}
                      name={workerName === "Other" ? "Other" : workerName.split("/").pop()}
                      stroke={workerName === "Other" ? OTHER_COLOR : workerColors[workerName]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card padding="md">
              <span className="text-[13px] font-semibold">Worker comparison</span>
              <p className="text-[11px] text-text-subtle font-mono mb-3">
                average outcome score (0–100)
              </p>
              {workerComparison.length === 0 ? (
                <p className="text-xs text-text-muted py-6 text-center">
                  No routing data in this window — Auto combos learn as they route
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(180, workerComparison.length * 34)}>
                  <BarChart
                    data={workerComparison}
                    layout="vertical"
                    margin={{ top: 2, right: 34, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="workerLabel"
                      width={110}
                      tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<WorkerTooltip />} contentStyle={TOOLTIP_STYLE} />
                    <Bar
                      dataKey="avgScore"
                      name="Average score"
                      barSize={16}
                      radius={[0, 4, 4, 0]}
                      isAnimationActive={false}
                    >
                      {workerComparison.map((model) => (
                        <Cell key={model.worker} fill={workerColors[model.worker] || OTHER_COLOR} />
                      ))}
                      <LabelList
                        dataKey="avgScore"
                        position="right"
                        formatter={(value) => Math.round(Number(value) || 0)}
                        fill="var(--color-text-muted)"
                        className="font-mono"
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card padding="md">
              <span className="text-[13px] font-semibold">Pick source</span>
              <p className="text-[11px] text-text-subtle font-mono mb-3">
                terminal selections in the selected window
              </p>
              {totalPicks === 0 ? (
                <p className="text-xs text-text-muted py-6 text-center">
                  No routing data in this window — Auto combos learn as they route
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={[{ name: "window", ...pickSource }]} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} vertical={false} />
                    <XAxis
                      type="number"
                      tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={48}
                      tick={{ className: "font-mono", fill: "currentColor", fillOpacity: 0.65, fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      itemStyle={{ color: "var(--color-text)" }}
                      labelStyle={{ color: "var(--color-text-muted)" }}
                    />
                    <Legend
                      formatter={(value) => (
                        <span className="font-mono text-[10px] text-text-muted">{value}</span>
                      )}
                    />
                    {PICK_SOURCES.map((source, index) => (
                      <Bar
                        key={source.key}
                        dataKey={source.key}
                        name={source.label}
                        stackId="s"
                        fill={index < 6 ? SERIES_COLORS[index] : OTHER_COLOR}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>

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
