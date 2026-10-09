/**
 * Meta Muse usage — POST /muse-code/key (the CLI's own startup key-mint call)
 *
 * The mint response carries `subs_usage` (rolling 5h window + weekly buckets)
 * alongside the inference key, so quota is read from the same call `muse`
 * makes at startup — no separate usage endpoint exists.
 *
 * Quota auth is the device-code DCA token (`providerSpecificData.dcaToken`,
 * falling back to the stored refreshToken which holds the same DCA value).
 * Minted `LLM|` inference keys and dashboard `LLM_` keys 401 here, so the
 * connection's accessToken/apiKey must never be sent.
 *
 * Mint response (quota-relevant subset):
 *   subs_tier_name, is_subs_active,
 *   subs_usage: {
 *     tier?,
 *     window: { used_percent, window_duration_mins, resets_at },
 *     weekly: { used_percent, resets_at },
 *   }
 * `used_percent` is % USED; `resets_at` is epoch seconds. Meta omits
 * `subs_usage` while the 5h window is idle — that is an empty reading, not
 * zero usage, so missing windows are skipped rather than zero-filled.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const MUSE_API_VERSION = "1.0.0";

function formatSessionLabel(windowDurationMins) {
  const mins = toFiniteNumber(windowDurationMins, NaN);
  if (!Number.isFinite(mins) || mins <= 0) return "Session";
  if (mins % 60 === 0) return `Session (${mins / 60}h)`;
  return `Session (${mins}m)`;
}

function toMuseQuota(usedPercent, resetsAt) {
  const used = Math.max(0, Math.min(100, usedPercent));
  const remaining = Math.max(0, 100 - used);
  return {
    used,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: parseResetTime(resetsAt),
    unlimited: false,
  };
}

export async function getMuseUsage(dcaToken, providerSpecificData = null, proxyOptions = null) {
  const stored = providerSpecificData && typeof providerSpecificData === "object"
    ? providerSpecificData
    : {};
  const storedPlan = typeof stored.subsTierName === "string" && stored.subsTierName.trim()
    ? stored.subsTierName.trim()
    : "";

  if (!dcaToken) {
    if (storedPlan) {
      return {
        plan: storedPlan,
        quotas: {},
        message: "Muse connected. Live quota unavailable — no device token stored, showing last known plan.",
      };
    }
    return { message: "Muse connected. Subscription quota requires OAuth sign-in (no device token stored)." };
  }

  const mintUrl = process.env.META_MINT_URL || U("muse").url;
  if (!mintUrl) {
    return { message: "Muse connected. Usage endpoint is not configured." };
  }

  let response;
  try {
    response = await proxyAwareFetch(mintUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${dcaToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-api-version": MUSE_API_VERSION,
      },
      body: "{}",
      identity: "muse-code",
      provider: "muse",
    }, proxyOptions);
  } catch (error) {
    return { message: `Muse connected. Unable to fetch usage: ${error.message}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { message: "Muse authentication expired. Please re-authorize the connection." };
  }

  if (!response.ok) {
    return { message: `Muse connected. Usage API temporarily unavailable (${response.status}).` };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { message: "Muse connected. Usage response was not JSON." };
  }

  const usage = data?.subs_usage && typeof data.subs_usage === "object" ? data.subs_usage : null;
  const plan = (typeof data?.subs_tier_name === "string" && data.subs_tier_name.trim())
    || (typeof usage?.tier === "string" && usage.tier.trim())
    || storedPlan
    || "Muse";

  // Pay-as-you-go accounts without an active subscription get no bars —
  // never a fake 0% reading.
  if (data?.is_subs_active === false) {
    return {
      plan,
      quotas: {},
      message: "Muse connected. No active subscription on this account.",
    };
  }

  const quotas = {};
  const window = usage?.window && typeof usage.window === "object" ? usage.window : null;
  const weekly = usage?.weekly && typeof usage.weekly === "object" ? usage.weekly : null;

  const windowUsed = toFiniteNumber(window?.used_percent, NaN);
  if (window && Number.isFinite(windowUsed)) {
    quotas[formatSessionLabel(window.window_duration_mins)] = toMuseQuota(windowUsed, window.resets_at);
  }

  const weeklyUsed = toFiniteNumber(weekly?.used_percent, NaN);
  if (weekly && Number.isFinite(weeklyUsed)) {
    quotas["Weekly (7d)"] = toMuseQuota(weeklyUsed, weekly.resets_at);
  }

  if (Object.keys(quotas).length === 0) {
    return {
      plan,
      quotas,
      message: "Muse connected. No active usage window reported — quota is idle.",
    };
  }

  return { plan, quotas };
}
