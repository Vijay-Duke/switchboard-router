// @ts-check
import crypto from "node:crypto";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config.js";

export const DEFAULT_AFFINITY_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_QUOTA_FRESH_MS = QUOTA_AUTOPING_CONFIG.tickIntervalMs * 2;
const MAX_AFFINITIES = 5_000;
const state = (global.__accountSchedulerV2 ??= { affinities: new Map() });

function affinityKey(providerId, sessionKey) {
  if (!sessionKey) return null;
  return crypto.createHash("sha256").update(`${providerId}\0${sessionKey}`).digest("hex");
}

function sweep(now) {
  for (const [key, entry] of state.affinities) {
    if (!entry || entry.expiresAt <= now) state.affinities.delete(key);
  }
}

function inFlight(candidate, getInFlightCount) {
  const count = Number(getInFlightCount(candidate.id));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function quota(candidate, now, freshMs) {
  const snapshot = candidate.lastQuota;
  const at = snapshot?.at;
  const remainingPercentage = snapshot?.remainingPercentage;
  if (!Number.isFinite(at) || now - at > freshMs || !Number.isFinite(remainingPercentage)) {
    return { tier: 1, remaining: -1, resetAt: Infinity };
  }

  const remaining = Math.max(0, Math.min(100, remainingPercentage));
  if (remaining > 0) return { tier: 2, remaining, resetAt: Infinity };

  const resetAt = new Date(snapshot?.resetAt).getTime();
  return {
    tier: 0,
    remaining: 0,
    resetAt: Number.isFinite(resetAt) && resetAt > now ? resetAt : Infinity,
  };
}

function rank(candidate, getInFlightCount, now, freshMs) {
  return {
    candidate,
    inFlight: inFlight(candidate, getInFlightCount),
    quota: quota(candidate, now, freshMs),
    priority: Number.isFinite(candidate.priority)
      ? candidate.priority
      : Number.MAX_SAFE_INTEGER,
    id: String(candidate.id),
  };
}

function compare(a, b) {
  return a.inFlight - b.inFlight
    || b.quota.tier - a.quota.tier
    || b.quota.remaining - a.quota.remaining
    || a.quota.resetAt - b.quota.resetAt
    || a.priority - b.priority
    || a.id.localeCompare(b.id);
}

function reasonFor(first, second) {
  if (!second) return "priority";
  if (first.inFlight !== second.inFlight) return "least-inflight";
  if (first.quota.tier !== second.quota.tier || first.quota.remaining !== second.quota.remaining) {
    return "quota-headroom";
  }
  if (first.quota.resetAt !== second.quota.resetAt) return "quota-reset";
  if (first.priority !== second.priority) return "priority";
  return "connection-id";
}

export function selectScheduledConnection(options) {
  const {
    providerId,
    candidates = [],
    sessionKey = null,
    affinityTtlMs = DEFAULT_AFFINITY_TTL_MS,
    quotaFreshMs = DEFAULT_QUOTA_FRESH_MS,
    getInFlightCount = () => 0,
    now = Date.now(),
  } = options || {};

  sweep(now);
  if (candidates.length === 0) {
    return {
      connection: null,
      reason: "no-candidates",
      affinityRebound: false,
      capacityLimited: false,
    };
  }

  const key = affinityKey(providerId, sessionKey);
  const prior = key ? state.affinities.get(key) : null;
  const eligible = [];
  for (const candidate of candidates) {
    const ranked = rank(candidate, getInFlightCount, now, quotaFreshMs);
    const cap = candidate.maxConcurrentRequests;
    if (!Number.isInteger(cap) || cap <= 0 || ranked.inFlight < cap) {
      eligible.push(ranked);
    }
  }

  if (eligible.length === 0) {
    return {
      connection: null,
      reason: "capacity-exhausted",
      affinityRebound: Boolean(prior),
      capacityLimited: true,
    };
  }

  const affinity = prior
    && eligible.find(({ candidate }) => candidate.id === prior.connectionId);
  if (affinity) {
    prior.expiresAt = now + affinityTtlMs;
    return {
      connection: affinity.candidate,
      reason: "session-affinity",
      affinityRebound: false,
      capacityLimited: false,
    };
  }

  eligible.sort(compare);
  const selected = eligible[0];
  if (key) {
    if (!state.affinities.has(key) && state.affinities.size >= MAX_AFFINITIES) {
      state.affinities.delete(state.affinities.keys().next().value);
    }
    state.affinities.set(key, {
      connectionId: selected.candidate.id,
      expiresAt: now + affinityTtlMs,
    });
  }

  return {
    connection: selected.candidate,
    reason: reasonFor(selected, eligible[1]),
    affinityRebound: Boolean(prior),
    capacityLimited: false,
  };
}

export function __resetAccountSchedulerForTests() {
  state.affinities.clear();
}
