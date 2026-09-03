"use client";

import { useState, useEffect } from "react";

const DEFAULT_POLL_MS = 30000;

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
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) setOnline(res.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };

    ping();
    const timer = setInterval(ping, intervalMs);
    // Re-probe as soon as the tab comes back instead of waiting for the next tick.
    document.addEventListener("visibilitychange", ping);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [intervalMs]);

  return { online };
}

export default useGatewayHealth;
