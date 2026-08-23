import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber, U } from "./shared.js";
import {
  GROK_CLI_FETCH_PROFILE,
  buildGrokCliApiHeaders,
} from "../../config/grokCli.js";

const unwrap = (value, fallback = 0) => value && typeof value === "object" && "val" in value
  ? toFiniteNumber(value.val, fallback)
  : toFiniteNumber(value, fallback);

function quota(used, total, resetAt = null) {
  const safeTotal = Math.max(0, total);
  const safeUsed = Math.max(0, used);
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage: safeTotal ? Math.max(0, ((safeTotal - safeUsed) / safeTotal) * 100) : 0,
    resetAt,
    unlimited: false,
  };
}

export function parseGrokCliBilling(billing, user = null) {
  const root = billing && typeof billing === "object" ? billing : {};
  const config = root.config && typeof root.config === "object" ? root.config : root;
  const resetAt = parseResetTime(config.billingPeriodEnd || config.currentPeriod?.end || config.resetAt);
  const tier = user?.subscriptionTier || user?.subscription_tier || user?.subscription?.tier || "";
  const subscriptionAccess = typeof tier === "string" && tier !== "" && !/^(free|none|null)$/i.test(tier);
  const quotas = {};

  const monthlyLimit = unwrap(config.monthlyLimit ?? root.monthlyLimit, NaN);
  const includedUsed = unwrap(config.includedUsed ?? root.includedUsed ?? config.totalUsed ?? root.totalUsed, 0);
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0) {
    quotas["Monthly included"] = quota(includedUsed, monthlyLimit, resetAt);
  }

  const cap = unwrap(config.onDemandCap ?? root.onDemandCap, NaN);
  const used = unwrap(config.onDemandUsed ?? root.onDemandUsed, 0);
  if (Number.isFinite(cap) && cap > 0) quotas["On-demand"] = quota(used, cap, resetAt);
  else if (!subscriptionAccess && cap === 0) quotas["On-demand"] = quota(1, 1, resetAt);

  const prepaid = unwrap(config.prepaidBalance ?? root.prepaidBalance, NaN);
  if (Number.isFinite(prepaid) && prepaid > 0) quotas.Prepaid = quota(0, prepaid);

  const plan = tier
    ? String(tier).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : user?.hasGrokCodeAccess ? "Grok Code" : "Grok Build";
  return { plan, quotas, subscriptionAccess };
}

export async function getGrokCliUsage(accessToken, providerSpecificData = null, proxyOptions = null) {
  if (!accessToken) return { message: "Grok CLI access token not available." };
  const headers = buildGrokCliApiHeaders(accessToken, providerSpecificData || {});
  const usage = U("grok-cli");
  try {
    const [billingResponse, userResponse] = await Promise.all([
      proxyAwareFetch(usage.url, {
        method: "GET", headers, ...GROK_CLI_FETCH_PROFILE,
      }, proxyOptions),
      proxyAwareFetch(usage.userUrl, {
        method: "GET", headers, ...GROK_CLI_FETCH_PROFILE,
      }, proxyOptions).catch(() => null),
    ]);
    if (billingResponse.status === 401 || billingResponse.status === 403) {
      return { message: "Grok CLI authentication expired. Please re-authorize." };
    }
    if (!billingResponse.ok) return { message: `Grok CLI billing API error (${billingResponse.status})` };
    const billing = await billingResponse.json();
    const user = userResponse?.ok ? await userResponse.json().catch(() => null) : null;
    const parsed = parseGrokCliBilling(billing, user);
    if (Object.keys(parsed.quotas).length) return { plan: parsed.plan, quotas: parsed.quotas };
    return {
      plan: parsed.plan,
      quotas: {},
      message: parsed.subscriptionAccess
        ? "Subscription access is active; Grok does not expose a numeric included quota."
        : "Grok Build connected, but no credit allotment was returned.",
    };
  } catch (error) {
    return { message: `Grok CLI usage error: ${error.message}` };
  }
}
