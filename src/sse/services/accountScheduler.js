// @ts-check
import crypto from "node:crypto";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config.js";

export const DEFAULT_AFFINITY_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_QUOTA_FRESH_MS = QUOTA_AUTOPING_CONFIG.tickIntervalMs * 2;
const MAX_AFFINITIES = 5_000;
const MAX_AFFINITIES_PER_SCOPE = 500;
const state = (global.__accountSchedulerV2 ??= { affinities: new Map() });

function hashTuple(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function affinityIdentity(providerId, clientKeyId, sessionKey) {
  if (!sessionKey) return null;
  const clientScope = clientKeyId || "local-no-key";
  return {
    key: hashTuple([String(providerId), String(clientScope), String(sessionKey)]),
    scopeHash: hashTuple([String(providerId), String(clientScope)]),
  };
}

function sweep(now) {
  for (const [key, entry] of state.affinities) {
    if (!entry || entry.expiresAt <= now) state.affinities.delete(key);
  }
}

function oldestKeyInScope(scopeHash) {
  for (const [key, entry] of state.affinities) {
    if (entry.scopeHash === scopeHash) return key;
  }
  return null;
}

function scopeSize(scopeHash) {
  let total = 0;
  for (const entry of state.affinities.values()) {
    if (entry.scopeHash === scopeHash) total += 1;
  }
  return total;
}

function setAffinity(identity, connectionId, expiresAt) {
  const exists = state.affinities.has(identity.key);
  if (!exists && scopeSize(identity.scopeHash) >= MAX_AFFINITIES_PER_SCOPE) {
    const oldest = oldestKeyInScope(identity.scopeHash);
    if (oldest) state.affinities.delete(oldest);
  }
  if (!exists && state.affinities.size >= MAX_AFFINITIES) {
    const oldest = oldestKeyInScope(identity.scopeHash);
    if (oldest) state.affinities.delete(oldest);
    else return;
  }
  state.affinities.set(identity.key, {
    connectionId,
    expiresAt,
    scopeHash: identity.scopeHash,
  });
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
    clientKeyId = null,
    sessionKey = null,
    affinityTtlMs = DEFAULT_AFFINITY_TTL_MS,
    quotaFreshMs = DEFAULT_QUOTA_FRESH_MS,
    getInFlightCount = () => 0,
    now = Date.now(),
  } = options || {};

  sweep(now);
  const identity = affinityIdentity(providerId, clientKeyId, sessionKey);
  const prior = identity ? state.affinities.get(identity.key) : null;
  if (candidates.length === 0) {
    if (prior) state.affinities.delete(identity.key);
    return {
      connection: null,
      reason: "no-candidates",
      affinityRebound: Boolean(prior),
      capacityLimited: false,
    };
  }
  const eligible = [];
  for (const candidate of candidates) {
    const ranked = rank(candidate, getInFlightCount, now, quotaFreshMs);
    const cap = candidate.maxConcurrentRequests;
    if (!Number.isInteger(cap) || cap <= 0 || ranked.inFlight < cap) {
      eligible.push(ranked);
    }
  }

  if (eligible.length === 0) {
    if (prior) state.affinities.delete(identity.key);
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
  if (identity) {
    setAffinity(
      identity,
      selected.candidate.id,
      now + affinityTtlMs,
    );
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
