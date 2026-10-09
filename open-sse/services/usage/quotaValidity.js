// Missing provider data is unknown, never zero usage or a full allowance.
export function quotaNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export const QUOTA_DISPLAY_MAX_AGE_MS = 10 * 60 * 1000;

export function quotaUnavailableReason(quota, now = Date.now()) {
  if (quota?.blocked === true) return "Provider reports limit reached";
  if (quota?.stale === true) return "Refresh unavailable";
  const observed = quota?.observedAt ? Date.parse(quota.observedAt) : NaN;
  if (quota?.observedAt && (!Number.isFinite(observed) || observed > now + 60000 || now - observed >= QUOTA_DISPLAY_MAX_AGE_MS)) {
    return "Observation expired";
  }
  const reset = quota?.resetAt ? Date.parse(quota.resetAt) : NaN;
  if (Number.isFinite(reset) && reset <= now) {
    return quota.recurring === false ? "Expired" : "Reset passed; refresh needed";
  }
  return null;
}

// `remaining` is an absolute quantity. Only `remainingPercentage` is a percent.
export function quotaRemainingPercent(quota, now = Date.now()) {
  if (!quota || quotaUnavailableReason(quota, now) || quota.kind === "balance") return null;
  if (quota.unlimited === true) return 100;
  const provided = quotaNumber(quota.remainingPercentage);
  if (provided !== null) return Math.max(0, Math.min(100, provided));
  const total = quotaNumber(quota.total);
  if (total === null || total <= 0) return null;
  const used = quotaNumber(quota.used);
  const remaining = quotaNumber(quota.remaining);
  if (used !== null && used >= 0) return Math.max(0, Math.min(100, (total - used) / total * 100));
  if (remaining !== null && remaining >= 0) return Math.max(0, Math.min(100, remaining / total * 100));
  return null;
}
