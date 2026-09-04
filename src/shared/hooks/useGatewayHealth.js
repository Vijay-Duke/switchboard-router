"use client";

import { useState, useEffect } from "react";

const DEFAULT_POLL_MS = 30000;

/**
 * Module-level shared poll: Header and Sidebar both call useGatewayHealth,
 * but only one interval + one in-flight probe ever runs. Late mounters get
 * the last known value immediately and join the subscriber set.
 */
const subscribers = new Set();
let pollTimer = null;
let pollIntervalMs = DEFAULT_POLL_MS;
let currentOnline = true;
let inflightPing = null;

function setSharedOnline(online) {
  if (currentOnline === online) return;
  currentOnline = online;
  for (const setOnline of subscribers) setOnline(online);
}

async function sharedPing() {
  if (typeof document !== "undefined" && document.hidden) return;
  if (!inflightPing) {
    inflightPing = fetch("/api/health", { cache: "no-store" })
      .then((res) => setSharedOnline(res.ok))
      .catch(() => setSharedOnline(false))
      .finally(() => {
        inflightPing = null;
      });
  }
  return inflightPing;
}

function ensureSharedPoll(intervalMs) {
  if (typeof document === "undefined") return;
  if (pollTimer) return;
  pollIntervalMs = intervalMs;
  pollTimer = setInterval(sharedPing, pollIntervalMs);
  // Re-probe as soon as the tab comes back instead of waiting for the next tick.
  document.addEventListener("visibilitychange", sharedPing);
}

function releaseSharedPoll() {
  if (subscribers.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", sharedPing);
  }
}

/**
 * Live gateway reachability via the existing /api/health probe.
 * Pings on mount and every `intervalMs`, paused while the tab is hidden.
 * Fail-closed: any throw or non-2xx marks the gateway offline until a
 * later probe succeeds.
 *
 * @param {{ intervalMs?: number }} [options]
 * @returns {{ online: boolean }}
 */
export function useGatewayHealth({ intervalMs = DEFAULT_POLL_MS } = {}) {
  const [online, setOnline] = useState(currentOnline);

  useEffect(() => {
    subscribers.add(setOnline);
    setOnline(currentOnline);
    ensureSharedPoll(intervalMs);
    sharedPing();
    return () => {
      subscribers.delete(setOnline);
      releaseSharedPoll();
    };
  }, [intervalMs]);

  return { online };
}

export default useGatewayHealth;
