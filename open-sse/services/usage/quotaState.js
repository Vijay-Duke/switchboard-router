// Only stable, non-secret account metadata crosses the quota-storage boundary.
// OAuth token refresh and display-name edits deliberately do not change this scope.
export function getQuotaStateIdentity(connection) {
  const data = connection?.providerSpecificData || {};
  const text = value => typeof value === "string" ? value : "";
  return {
    connectionId: text(connection?.id),
    provider: text(connection?.provider),
    authType: text(connection?.authType),
    createdAt: text(connection?.createdAt),
    email: text(connection?.email),
    accountId: text(data.accountUuid || data.accountId || data.userId || data.chatgptAccountId),
    organizationId: text(data.organizationUuid || data.organizationId),
  };
}

export const QUOTA_STATE_TTL_MS = 300000;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Do not persist an arbitrary provider response: it could contain credentials,
// error bodies, or a stale snapshot dressed up as a new observation.
export function sanitizeQuotaState(value) {
  const retryAt = iso(value?.retryAt);
  const input = value?.result;
  let result = null;
  const observedAt = iso(input?.observedAt);
  if (observedAt && input?.quotas && typeof input.quotas === "object" && !Array.isArray(input.quotas)) {
    const quotas = {};
    for (const [name, quota] of Object.entries(input.quotas)) {
      if (!quota || !["used", "total", "remaining", "remainingPercentage"].every(key => Number.isFinite(quota[key]))) continue;
      quotas[name] = {
        used: quota.used, total: quota.total, remaining: quota.remaining,
        remainingPercentage: quota.remainingPercentage,
        resetAt: iso(quota.resetAt), unlimited: quota.unlimited === true,
      };
    }
    result = { plan: typeof input.plan === "string" ? input.plan : null, observedAt, quotas };
    if (input.extraUsage && typeof input.extraUsage === "object") {
      result.extraUsage = {};
      for (const key of ["is_enabled", "monthly_limit", "used_credits", "utilization"]) {
        const item = input.extraUsage[key];
        if (typeof item === "boolean" || Number.isFinite(item)) result.extraUsage[key] = item;
      }
    } else result.extraUsage = null;
  }
  const expiresAt = result && Number.isFinite(value?.expiresAt)
    ? Math.max(0, Math.min(value.expiresAt, Date.parse(result.observedAt) + QUOTA_STATE_TTL_MS)) : 0;
  return { retryAt, result, expiresAt };
}

export function mergeQuotaState(previous, incoming) {
  const old = sanitizeQuotaState(previous);
  const next = sanitizeQuotaState(incoming);
  const result = !old.result || (next.result && Date.parse(next.result.observedAt) >= Date.parse(old.result.observedAt))
    ? next.result : old.result;
  const deadline = Math.max(Date.parse(old.retryAt) || 0, Date.parse(next.retryAt) || 0);
  // A successful observation can clear an expired cooldown, never a future one
  // written by another process while this request was in flight.
  const retryAt = deadline > (Date.parse(result?.observedAt) || 0) ? new Date(deadline).toISOString() : null;
  const expiresAt = retryAt || !result || next.expiresAt === 0 ? 0
    : result === next.result ? next.expiresAt : old.expiresAt;
  return { retryAt, result, expiresAt };
}
