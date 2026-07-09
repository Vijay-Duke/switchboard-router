"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import PropTypes from "prop-types";

const STRATEGY_LABELS = {
  fallback: "fallback",
  "round-robin": "round-robin",
  fusion: "fusion",
  auto: "auto",
};

/**
 * Overview — live endpoint stats + honest combo strategy summary (not always Auto).
 */
export default function OverviewClient({ initialData }) {
  const [host, setHost] = useState("127.0.0.1:20128");
  const [stats, setStats] = useState(null);

  const providerCount = initialData?.providerCount ?? 0;
  const keyCount = initialData?.keyCount ?? 0;
  const comboCount = initialData?.comboCount ?? 0;
  const defaultCombo = initialData?.defaultCombo || null;
  const learningSummary = initialData?.learningSummary || null;
  const quotas = initialData?.quotas || [];
  const isAuto = !!defaultCombo?.isAuto;
  const strategy = defaultCombo?.strategy || "fallback";

  useEffect(() => {
    setHost(window.location.host || "127.0.0.1:20128");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage/stats?period=24h")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const endpointUrl = `http://${host}/v1`;

  const homeStats = useMemo(() => {
    const req = stats?.totalRequests ?? stats?.requests ?? 0;
    const prompt = stats?.totalPromptTokens ?? 0;
    const completion = stats?.totalCompletionTokens ?? 0;
    const cost = stats?.totalCost ?? 0;
    return [
      { label: "Requests · 24h", value: formatNum(req) },
      { label: "Tokens in", value: formatNum(prompt) },
      { label: "Tokens out", value: formatNum(completion) },
      { label: "Est. cost", value: cost ? `$${Number(cost).toFixed(2)}` : "$0.00" },
    ];
  }, [stats]);

  const routingRows = useMemo(() => {
    if (!defaultCombo) {
      return [
        ["Combos", "none configured"],
        ["Strategy", "—"],
        ["Models", "—"],
        ["Tip", "Create a combo to group models"],
      ];
    }
    if (isAuto) {
      return [
        ["Router", defaultCombo.routerModel || "claude/claude-opus-4-8"],
        ["Worker pool", `${defaultCombo.workerCount || 0} workers`],
        ["Objective", defaultCombo.objective || "balanced"],
        ["Exploration", defaultCombo.exploration || "5%"],
      ];
    }
    if (strategy === "fusion") {
      return [
        ["Panel", `${defaultCombo.workerCount || 0} models`],
        ["Judge", defaultCombo.judgeModel || "first model"],
        ["Calls / request", "N+1 (panel + judge)"],
        ["Capacity switch", defaultCombo.capacityAutoSwitch ? "on" : "off"],
      ];
    }
    if (strategy === "round-robin") {
      return [
        ["Pool", `${defaultCombo.workerCount || 0} models`],
        ["Rotation", "spread load across models"],
        ["Capacity switch", defaultCombo.capacityAutoSwitch ? "on" : "off"],
        ["On failure", "try next in rotation"],
      ];
    }
    // fallback
    return [
      ["Pool", `${defaultCombo.workerCount || 0} models`],
      ["Order", "try in listed order"],
      ["Capacity switch", defaultCombo.capacityAutoSwitch !== false ? "on" : "off"],
      ["On failure", "next model"],
    ];
  }, [defaultCombo, isAuto, strategy]);

  return (
    <div className="flex flex-col w-full" style={{ gap: 16, maxWidth: 1120 }}>
      <div className="flex flex-col" style={{ gap: 4 }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: "#ECE4D2" }}>Overview</span>
        <span
          style={{
            fontSize: 12,
            color: "#6F6653",
            fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
          }}
        >
          everything routing through your endpoint, at a glance
        </span>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {/* Endpoint */}
        <div
          className="flex flex-col justify-between"
          style={{
            background: "#1E1A13",
            border: "1px solid #332C1E",
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span
                style={{
                  fontSize: 10.5,
                  letterSpacing: "1.2px",
                  color: "#8A7F66",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Endpoint
              </span>
              <span
                className="flex items-center gap-[7px]"
                style={{
                  fontSize: 11.5,
                  color: "#74C08A",
                  fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                }}
              >
                <span className="console-online-dot" />
                online
              </span>
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                fontSize: 16,
                color: "#E5B454",
                marginBottom: 4,
                wordBreak: "break-all",
              }}
            >
              {endpointUrl}
            </div>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "#6F6653",
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
              marginTop: 14,
            }}
          >
            {keyCount} API key{keyCount === 1 ? "" : "s"} · {providerCount} provider
            {providerCount === 1 ? "" : "s"} connected
          </div>
        </div>

        {/* Combos / Learning — only claim Auto when strategy is auto */}
        <div
          style={{
            background: "#1E1A13",
            border: "1px solid #332C1E",
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <span
              style={{
                fontSize: 10.5,
                letterSpacing: "1.2px",
                color: "#8A7F66",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              {isAuto ? "Learning" : "Combos"}
            </span>
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                padding: "2px 8px",
                borderRadius: 999,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                background: "rgba(229,180,84,.15)",
                color: "#E5B454",
                border: "1px solid rgba(229,180,84,.4)",
              }}
            >
              {isAuto
                ? learningSummary?.freezeLearning
                  ? "frozen"
                  : learningSummary?.version
                    ? `v${learningSummary.version}`
                    : "no version yet"
                : comboCount
                  ? `${comboCount} configured`
                  : "none"}
            </span>
          </div>
          <div className="flex items-end gap-2.5" style={{ marginBottom: 3 }}>
            <span
              style={{
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                fontSize: 32,
                fontWeight: 600,
                lineHeight: 1,
                color: "#ECE4D2",
              }}
            >
              {isAuto
                ? learningSummary?.evalScore != null
                  ? Number(learningSummary.evalScore).toFixed(0)
                  : "—"
                : String(comboCount)}
            </span>
            <span
              style={{
                fontSize: 11,
                color: isAuto ? "#74C08A" : "#A99E86",
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                paddingBottom: 3,
              }}
            >
              {isAuto ? "eval score" : "combos"}
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#6F6653",
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
              marginBottom: 14,
            }}
          >
            {isAuto
              ? "Auto strategy · relearn from Combos → Insights"
              : "Group models · fallback / round-robin / fusion / auto"}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <Link
              href="/dashboard/combos"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                background: "rgba(229,180,84,.15)",
                border: "1px solid rgba(229,180,84,.4)",
                borderRadius: 7,
                padding: "7px 12px",
                fontSize: 12,
                color: "#E5B454",
                fontFamily: "inherit",
              }}
            >
              {comboCount ? "Manage combos" : "Create combo"}
            </Link>
            {isAuto && defaultCombo?.name && (
              <Link
                href={`/dashboard/combos/routing?combo=${encodeURIComponent(defaultCombo.name)}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  background: "transparent",
                  border: "1px solid #3A3221",
                  borderRadius: 7,
                  padding: "7px 10px",
                  fontSize: 12,
                  color: "#A99E86",
                }}
              >
                Routing insights
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {homeStats.map((u) => (
          <div
            key={u.label}
            style={{
              background: "#1E1A13",
              border: "1px solid #332C1E",
              borderRadius: 11,
              padding: 15,
            }}
          >
            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.6px",
                color: "#6F6653",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              {u.label}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                fontSize: 21,
                fontWeight: 600,
                color: "#ECE4D2",
              }}
            >
              {u.value}
            </div>
          </div>
        ))}
      </div>

      {/* Active routing + Quota */}
      <div className="grid gap-4 items-start grid-cols-1 md:grid-cols-2">
        <div
          style={{
            background: "#1E1A13",
            border: "1px solid #332C1E",
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ECE4D2" }}>
              Active routing
            </span>
            <Link
              href={
                isAuto && defaultCombo?.name
                  ? `/dashboard/combos/routing?combo=${encodeURIComponent(defaultCombo.name)}`
                  : "/dashboard/combos"
              }
              style={{
                padding: "6px 12px",
                borderRadius: 7,
                fontSize: 11.5,
                border: "1px solid #3A3221",
                background: "transparent",
                color: "#A99E86",
              }}
            >
              {isAuto ? "View insights" : "Open combos"}
            </Link>
          </div>
          <div className="flex items-center gap-2.5" style={{ marginBottom: 14 }}>
            <span
              style={{
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                fontSize: 14,
                fontWeight: 600,
                color: "#ECE4D2",
              }}
            >
              {defaultCombo?.name || "—"}
            </span>
            <span
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                padding: "2px 8px",
                borderRadius: 999,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                background: "rgba(229,180,84,.15)",
                color: "#E5B454",
                border: "1px solid rgba(229,180,84,.4)",
              }}
            >
              {STRATEGY_LABELS[strategy] || strategy || "fallback"}
            </span>
          </div>
          <div className="flex flex-col">
            {routingRows.map(([label, value], i, arr) => (
              <div
                key={label}
                className="flex items-center justify-between gap-3"
                style={{
                  padding: "9px 0",
                  borderBottom: i < arr.length - 1 ? "1px solid #241F16" : "none",
                }}
              >
                <span style={{ fontSize: 12, color: "#8A7F66" }}>{label}</span>
                <span
                  className="truncate text-right"
                  style={{
                    fontSize: 12,
                    color: "#A99E86",
                    fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                    maxWidth: "60%",
                  }}
                  title={String(value)}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            background: "#1E1A13",
            border: "1px solid #332C1E",
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#ECE4D2" }}>Quota</span>
            <span
              style={{
                fontSize: 11,
                color: "#6F6653",
                fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
              }}
            >
              {quotas.length || providerCount} accounts
            </span>
          </div>
          <div className="flex flex-col" style={{ gap: 13 }}>
            {(quotas.length
              ? quotas
              : [{ account: "No quota data yet", pct: 0 }]
            )
              .slice(0, 6)
              .map((q) => {
                const pct = Math.max(0, Math.min(100, Number(q.pct) || 0));
                const color =
                  pct >= 90 ? "#E07070" : pct >= 70 ? "#E5B454" : "#74C08A";
                return (
                  <div key={q.account} className="flex flex-col" style={{ gap: 5 }}>
                    <div className="flex justify-between items-baseline gap-2">
                      <span style={{ fontSize: 12, color: "#ECE4D2" }}>{q.account}</span>
                      <span
                        style={{
                          fontSize: 11,
                          color,
                          fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
                        }}
                      >
                        {pct}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 3,
                        background: "#241F16",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${pct}%`,
                          borderRadius: 3,
                          background: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
          <Link
            href="/dashboard/quota"
            className="inline-block mt-4"
            style={{ fontSize: 11.5, color: "#A99E86" }}
          >
            Open quota tracker →
          </Link>
        </div>
      </div>
    </div>
  );
}

function formatNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

OverviewClient.propTypes = {
  initialData: PropTypes.object,
};
