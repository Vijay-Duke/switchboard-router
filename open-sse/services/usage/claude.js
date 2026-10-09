/**
 * Claude usage handler
 */

import { getOpenSseDeps } from "../../runtimeDeps.js";
import { QUOTA_STATE_TTL_MS } from "./quotaState.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

// Dedup + short TTL cache per account (or token for direct callers). Many tabs / many accounts / auto-refresh
// all funnel through here; without this each call hits Anthropic and triggers 429.
const USAGE_CACHE_TTL_MS = QUOTA_STATE_TTL_MS;
const usageCache = new Map(); // account/token -> { promise?, result?, expiresAt }

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;
  const identity = options?.quotaIdentity;
  const cacheKey = identity?.connectionId && identity.createdAt
    ? JSON.stringify(identity) : options?.connectionId || accessToken;
  const hit = cacheKey && usageCache.get(cacheKey);
  if (hit?.promise) return hit.promise;
  let stale = hit?.result || null;
  let expiresAt = hit?.expiresAt || 0;
  const deps = getOpenSseDeps();
  const durable = identity?.connectionId && identity.createdAt
    && deps.loadProviderQuotaState && deps.saveProviderQuotaState;
  if (!durable && !force && expiresAt > Date.now() && !(oauthCooldown.get(cacheKey) > Date.now())) {
    return stale;
  }

  const promise = (async () => {
    if (durable) {
      let state;
      try { state = await deps.loadProviderQuotaState(identity); } catch {
        // A failed storage read must not forget a possible upstream cooldown.
        const knownUntil = oauthCooldown.get(cacheKey);
        const failure = knownUntil > Date.now() ? subscriptionCooldown(knownUntil) : {
          code: "quota_state_unavailable",
          message: "Claude quota history is temporarily unavailable. Try again after storage recovers.",
        };
        return stale ? { ...stale, ...failure, stale: true } : failure;
      }
      if (state?.invalidIdentity) return changedConnection();
      if (state?.result && (!stale || Date.parse(state.result.observedAt) >= Date.parse(stale.observedAt))) {
        stale = state.result;
        expiresAt = hit?.expiresAt === 0 && hit.result?.observedAt === state.result.observedAt
          ? 0 : state.expiresAt || 0;
      }
      const retryAt = Date.parse(state?.retryAt);
      if (Number.isFinite(retryAt)) oauthCooldown.set(cacheKey, Math.max(oauthCooldown.get(cacheKey) || 0, retryAt));
    }
    const until = oauthCooldown.get(cacheKey);
    if (until > Date.now()) {
      return stale ? { ...stale, ...subscriptionCooldown(until), stale: true } : subscriptionCooldown(until);
    }
    if (!force && expiresAt > Date.now() && stale) {
      usageCache.set(cacheKey, { result: stale, expiresAt });
      return stale;
    }

    const result = await fetchClaudeUsageRaw(accessToken, proxyOptions, cacheKey);
    const fresh = result?.quotas && !result.stale;
    if (durable) {
      try {
        const saved = await deps.saveProviderQuotaState(identity, {
          retryAt: result.status === 429 ? result.retryAt : null,
          result: fresh ? result : stale,
          expiresAt: fresh ? Date.parse(result.observedAt) + USAGE_CACHE_TTL_MS : 0,
        });
        // A response for the previous account must not be attached to a newly
        // edited or deleted connection while the upstream call was in flight.
        if (saved === false) return changedConnection();
      } catch {
        // Keep the in-process backoff even if SQLite cannot persist it.
        console.warn("[Usage] Unable to persist quota state; retaining in-process backoff.");
      }
    }
    if (cacheKey && fresh) {
      usageCache.set(cacheKey, { result, expiresAt: Date.parse(result.observedAt) + USAGE_CACHE_TTL_MS });
      return result;
    }
    return stale ? { ...stale, ...result, stale: true } : result;
  })();

  if (cacheKey) usageCache.set(cacheKey, { promise, result: stale, expiresAt });
  void promise.then(() => {
    const entry = usageCache.get(cacheKey);
    if (cacheKey && entry?.promise === promise) {
      if (stale) usageCache.set(cacheKey, { result: stale, expiresAt: 0 });
      else usageCache.delete(cacheKey);
    }
  });
  return promise;
}

function changedConnection() {
  return { code: "connection_changed", message: "Claude connection changed. Reload its quota information." };
}

function subscriptionCooldown(until) {
  const retryAt = new Date(until).toISOString();
  return {
    status: 429,
    code: "rate_limited",
    retryAt,
    retryAfterSeconds: Math.max(0, Math.ceil((until - Date.now()) / 1000)),
    message: `Claude subscription usage is rate-limited. Try again after ${new Date(until).toUTCString()}.`,
  };
}

function retryDeadline(response) {
  const value = response.headers.get("retry-after");
  const seconds = value?.trim() ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + Math.max(1000, seconds * 1000);
  if (Number.isFinite(date) && date > Date.now()) return date;
  return Date.now() + OAUTH_429_COOLDOWN_MS;
}

async function fetchClaudeUsageRaw(accessToken, proxyOptions = null, cacheKey = accessToken) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(cacheKey);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return subscriptionCooldown(cooldownUntil);
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
      identity: "claude-cli",
      provider: "claude",
      format: "claude",
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && Number.isFinite(window.utilization) && window.utilization >= 0;

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        observedAt: new Date().toISOString(),
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // This is a subscription OAuth endpoint, not the organization Admin API.
    // Preserve its real failure and honor provider backoff instead of trying
    // settings/admin routes that this credential was never intended to access.
    if (oauthResponse.status === 429) {
      const until = retryDeadline(oauthResponse);
      oauthCooldown.set(cacheKey, until);
      return subscriptionCooldown(until);
    }
    if (oauthResponse.status === 401) {
      return {
        status: 401,
        code: "authentication_error",
        message: "Claude subscription session expired or is unauthorized. Reconnect Claude if refreshing the session fails.",
      };
    }
    return {
      status: oauthResponse.status,
      code: oauthResponse.status === 403 ? "permission_denied" : "usage_unavailable",
      message: `Claude subscription usage is unavailable (HTTP ${oauthResponse.status}).`,
    };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
