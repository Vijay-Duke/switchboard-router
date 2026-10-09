/**
 * GitHub Copilot usage handler
 */

import { quotaNumber } from "./quotaValidity.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime } from "./shared.js";

/**
 * GitHub Copilot Usage
 * Uses GitHub accessToken (not copilotToken) to call copilot_internal/user API
 */
export async function getGitHubUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    if (!accessToken) {
      throw new Error("No GitHub access token available. Please re-authorize the connection.");
    }

    // copilot_internal/user API requires GitHub OAuth token, not copilotToken
    const response = await proxyAwareFetch(U("github").url, {
      headers: {
        "Authorization": `token ${accessToken}`,
        "Accept": "application/json",
      },
      identity: "copilot",
      provider: "github",
      format: "openai",
    }, proxyOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    const data = await response.json();

    // Handle different response formats (paid vs free)
    if (data.quota_snapshots) {
      // Paid plan format
      const snapshots = data.quota_snapshots;
      const resetAt = parseResetTime(data.quota_reset_date_utc || data.quota_reset_date);

      return {
        plan: data.copilot_plan,
        resetDate: data.quota_reset_date,
        quotas: {
          chat: { ...formatGitHubQuotaSnapshot(snapshots.chat), resetAt: parseResetTime(snapshots.chat?.quota_reset_at) || resetAt },
          completions: { ...formatGitHubQuotaSnapshot(snapshots.completions), resetAt: parseResetTime(snapshots.completions?.quota_reset_at) || resetAt },
          premium_interactions: { ...formatGitHubQuotaSnapshot(snapshots.premium_interactions), resetAt: parseResetTime(snapshots.premium_interactions?.quota_reset_at) || resetAt },
        },
      };
    } else if (data.monthly_quotas || data.limited_user_quotas) {
      // Free/limited plan format
      const monthlyQuotas = data.monthly_quotas || {};
      const usedQuotas = data.limited_user_quotas || {};
      const resetAt = parseResetTime(data.limited_user_reset_date);

      return {
        plan: data.copilot_plan || data.access_type_sku,
        resetDate: data.limited_user_reset_date,
        quotas: {
          chat: {
            used: quotaNumber(monthlyQuotas.chat) !== null && quotaNumber(usedQuotas.chat) !== null ? Math.max(0, quotaNumber(monthlyQuotas.chat) - quotaNumber(usedQuotas.chat)) : null,
            remaining: quotaNumber(usedQuotas.chat),
            total: quotaNumber(monthlyQuotas.chat),
            unlimited: false,
            resetAt,
          },
          completions: {
            used: quotaNumber(monthlyQuotas.completions) !== null && quotaNumber(usedQuotas.completions) !== null ? Math.max(0, quotaNumber(monthlyQuotas.completions) - quotaNumber(usedQuotas.completions)) : null,
            remaining: quotaNumber(usedQuotas.completions),
            total: quotaNumber(monthlyQuotas.completions),
            unlimited: false,
            resetAt,
          },
        },
      };
    }

    return { message: "GitHub Copilot connected. Unable to parse quota data." };
  } catch (error) {
    throw new Error(`Failed to fetch GitHub usage: ${error.message}`);
  }
}

function formatGitHubQuotaSnapshot(quota) {
  if (!quota) return { used: null, total: null, unlimited: false };
  const total = quotaNumber(quota.entitlement);
  const remaining = quotaNumber(quota.quota_remaining ?? quota.remaining);
  const reportedUsed = quotaNumber(quota.credits_used);

  return {
    used: reportedUsed ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null),
    remainingPercentage: quotaNumber(quota.percent_remaining),
    total,
    remaining,
    unlimited: quota.unlimited || false,
  };
}
