// @ts-check
/**
 * Background DB readiness heartbeat for /api/health.
 * Readiness is served from an in-memory snapshot so concurrent health probes
 * never pile synchronous SQLite work on the event loop.
 */
import { getAdapter } from "./driver.js";

const HEARTBEAT_INTERVAL_MS = 2_000;
/** If the heartbeat has not completed within this window, report degraded. */
export const READINESS_STALE_MS = 12_000;

/** @type {{ ok: boolean, updatedAt: number }} */
let snapshot = { ok: false, updatedAt: 0 };
let started = false;
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
let probeGeneration = 0;

export function startDbHealthHeartbeat() {
  if (started) return;
  started = true;
  void runProbe();
  timer = setInterval(() => void runProbe(), HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
}

async function runProbe() {
  const generation = ++probeGeneration;
  try {
    const db = await getAdapter();
    if (generation !== probeGeneration) return;
    db.get("SELECT 1");
    if (generation !== probeGeneration) return;
    snapshot = { ok: true, updatedAt: Date.now() };
  } catch {
    if (generation !== probeGeneration) return;
    snapshot = { ok: false, updatedAt: Date.now() };
  }
}

export function getDbReadinessFromHeartbeat() {
  if (!snapshot.updatedAt) return false;
  if (Date.now() - snapshot.updatedAt > READINESS_STALE_MS) return false;
  return snapshot.ok;
}

export function __resetDbHealthHeartbeatForTests() {
  probeGeneration += 1;
  snapshot = { ok: false, updatedAt: 0 };
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** @param {{ ok: boolean, updatedAt?: number }} state */
export function __setDbHealthHeartbeatSnapshotForTests(state) {
  snapshot = { ok: state.ok, updatedAt: state.updatedAt ?? Date.now() };
}
