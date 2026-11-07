/**
 * Misc usage handlers (Qwen, iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime } from "./shared.js";
import { quotaNumber } from "./quotaValidity.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * Qwen Usage
 */
export async function getQwenUsage(accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: "Qwen connected. No resource URL available." };
    }

    // Qwen may have usage endpoint at resource URL
    return { message: "Qwen connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch Qwen usage." };
  }
}

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — session (5h) + weekly (7d) `usage` is a 0..1
 *   ratio (1.0 = limit reached, e.g. weekly 100% used). No reset timestamp exposed.
 * POST https://ollama.com/api/me — plan label (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};
const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Free plan: "usage resets monthly from the date you signed up" (ollama.com/pricing).
export function nextMonthlyResetFromSignup(createdAt, now = new Date()) {
  const anchor = new Date(createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

function clampPercent(value, fallback = null) {
  const n = quotaNumber(value);
  return n === null ? fallback : Math.max(0, Math.min(100, n));
}

// /api/balance (upstream #5026): active limits moved here; /api/usage now
// only reports history for many accounts. Fail-open — returns {} on error.
async function fetchOllamaBalanceQuotas(apiKey, proxyOptions) {
  let res = null;
  try {
    res = await proxyAwareFetch(OLLAMA_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    }, proxyOptions);
  } catch {
    return {};
  }
  if (!res?.ok) return {};
  let data = null;
  try { data = await res.json(); } catch { return {}; }
  const quotas = {};
  const inc = data?.included;
  for (const [key, label] of [["session", "Session (5h)"], ["weekly", "Weekly (7d)"]]) {
    if (!inc?.[key]) continue;
    const remPct = clampPercent(inc[key].remaining_percent);
    if (remPct === null) continue;
    quotas[label] = {
      used: Math.round((100 - remPct) * 100) / 100,
      total: 100,
      remainingPercentage: remPct,
      resetAt: parseResetTime(inc[key].resets_at),
      unlimited: false,
    };
  }
  const allowance = quotaNumber(inc?.allowance_usd);
  const balance = quotaNumber(inc?.balance_usd);
  if (allowance !== null && balance !== null && allowance > 0) {
    quotas["Allowance ($)"] = {
      used: Math.max(0, Math.round((allowance - balance) * 100) / 100),
      total: allowance,
      remainingPercentage: Math.max(0, Math.min(100, Math.round((balance / allowance) * 10000) / 100)),
      resetAt: parseResetTime(inc?.period?.until),
      unlimited: false,
      unit: "USD",
    };
  }
  const purchased = quotaNumber(data?.purchased?.balance_usd);
  if (purchased !== null && purchased > 0) {
    // Prepaid pot: Switchboard's balance row shape (see deepseek/grok-cli).
    quotas["Purchased Credits"] = {
      kind: "balance",
      balance: purchased,
      unit: "USD",
      used: null,
      total: null,
      remainingPercentage: null,
      resetAt: null,
      unlimited: false,
      recurring: false,
    };
  }
  return quotas;
}

export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    // Paid plans report session (5h) + weekly (7d); the free plan reports a
    // single monthly window whose reset is anchored on the signup date.
    const monthlyResetAt = planRaw.toLowerCase() === "free" && me?.CreatedAt
      ? nextMonthlyResetFromSignup(me.CreatedAt)
      : null;

    let quotas = {};
    for (const [key, label] of Object.entries(OLLAMA_LIMIT_WINDOWS)) {
      const ratio = quotaNumber(limits[key]?.usage);
      if (ratio === null || ratio < 0 || ratio > 1) continue;
      quotas[label] = ratioQuota(ratio, key === "monthly" ? monthlyResetAt : null);
    }

    if (Object.keys(quotas).length === 0) {
      quotas = await fetchOllamaBalanceQuotas(apiKey, proxyOptions);
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(limit.type)) continue;
      if (limit.type === "TIME_LIMIT") {
        quotas["Tools"] = { used: quotaNumber(limit.currentValue), total: quotaNumber(limit.usage), remaining: quotaNumber(limit.remaining), resetAt: parseResetTime(limit.nextResetTime), unlimited: false };
        continue;
      }
      const usedPercent = quotaNumber(limit.percentage);

      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = usedPercent === null || usedPercent < 0 ? null : Math.max(0, 100 - usedPercent);

      // Key by window (unit 3 = hours, unit 6 = weekly) so credit plans and
      // multi-interval plans don't overwrite each other (upstream fcfcced4).
      let base;
      if (limit.unit === 3 && Number(limit.number) > 0) base = `Session (${limit.number}h)`;
      else if (limit.unit === 6) base = "Weekly (7d)";
      else if (limit.type === "TOKENS_LIMIT") base = "session";
      else base = Number(limit.number) > 0 ? `Limit (${limit.number})` : "Credits";
      let name = base;
      for (let i = 2; quotas[name]; i++) name = `${base} ${i}`;
      quotas[name] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: parseResetTime(resetMs),
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    const balance = quotaNumber(data?.balance);
    const totalUsed = quotaNumber(data?.total_used);
    if (balance === null || balance < 0) {
      return { plan: "Pay-as-you-go", message: "Credit balance unavailable.", quotas: {} };
    }
    // The endpoint reports a cash balance, not the account's credit allowance.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Balance (USD)": {
          kind: "balance", balance, unit: "USD", used: totalUsed,
          total: null, remainingPercentage: null, unlimited: false, resetAt: null,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U("qoder").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? parseResetTime(expiresAtMs) : null;
    const quotas = {
      user: {
        total: quotaNumber(userQuota.total),
        used: quotaNumber(userQuota.used),
        remaining: quotaNumber(userQuota.remaining),
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: quotaNumber(orgQuota.total),
        used: quotaNumber(orgQuota.used),
        remaining: quotaNumber(orgQuota.remaining),
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
