// @ts-check
import { quotaNumber, quotaRemainingPercent } from "open-sse/services/usage/quotaValidity.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";

// ─── Constants ───────────────────────────────────────────────────────────────
export const QUOTA_CACHE_KEY = "quotaCacheData";
export const REFRESH_INTERVAL_MS = 60000;
// Claude usage/quota endpoint rate-limits; poll it less often than other providers
export const CLAUDE_REFRESH_INTERVAL_MS = 600000;
export const DEPLETED_QUOTA_THRESHOLD = 5;
export const AUTO_REFRESH_STORAGE_KEY = "quotaAutoRefresh";
export const CONNECTIONS_PAGE_SIZE = 20;
export const ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
export const ACCOUNT_PAGE_SIZE_MAX = 500;
export const ACCOUNT_FILTER_OPTIONS = [
  { value: "all", label: "All accounts" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Turned off" },
];
export const QUOTA_SORT_OPTIONS = [
  { value: "default", label: "Default quota order" },
  { value: "remaining-asc", label: "% quota: low to high" },
  { value: "remaining-desc", label: "% quota: high to low" },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────
export function getConnectionLabel(connection) {
  return connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || null;
}

export function getConnectionQuotaRemaining(connection, quotaData) {
  const quota = quotaData[connection.id]?.quotas?.[0];
  if (!quota) return Number.POSITIVE_INFINITY;
  const remaining = getRemainingPercentage(quota);
  if (remaining !== null) return remaining;
  return Number.POSITIVE_INFINITY;
}

// Stable group-by-provider: first-seen provider order, original order within group.
function groupByProviderStable(connections) {
  const seen = new Map();
  for (const conn of connections) {
    const key = conn.provider || "";
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(conn);
  }
  return Array.from(seen.values()).flat();
}


export function sortVisibleConnections(
  connections,
  quotaData,
  expiringFirst,
  providerFilter,
  quotaSortMode,
) {
  if (providerFilter === "codex" && quotaSortMode !== "default") {
    // O10: quota-less cards report +Infinity; Infinity - Infinity is NaN,
    // which would skip the name tiebreak — normalize to a finite sentinel.
    const norm = (v) => (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER);
    return [...connections].sort((a, b) => {
      const remainingA = norm(getConnectionQuotaRemaining(a, quotaData));
      const remainingB = norm(getConnectionQuotaRemaining(b, quotaData));
      const remainingDiff =
        quotaSortMode === "remaining-asc"
          ? remainingA - remainingB
          : remainingB - remainingA;
      if (remainingDiff !== 0) return remainingDiff;
      return (getConnectionLabel(a) || "").localeCompare(
        getConnectionLabel(b) || "",
      );
    });
  }

  if (!expiringFirst) return groupByProviderStable(connections);

  const getEarliestResetTime = (connection) => {
    const resetTimes = (quotaData[connection.id]?.quotas || [])
      .map((quota) =>
        quota.resetAt
          ? new Date(quota.resetAt).getTime()
          : Number.POSITIVE_INFINITY,
      )
      .filter((time) => Number.isFinite(time));
    return resetTimes.length > 0
      ? Math.min(...resetTimes)
      : Number.POSITIVE_INFINITY;
  };

  // Same O10 root cause: two reset-less accounts both yield +Infinity.
  const normTime = (v) => (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER);
  return [...connections].sort((a, b) => {
    const expiryDiff = normTime(getEarliestResetTime(a)) - normTime(getEarliestResetTime(b));
    if (expiryDiff !== 0) return expiryDiff;
    return (
      (a.provider || "").localeCompare(b.provider || "") ||
      (getConnectionLabel(a) || "").localeCompare(getConnectionLabel(b) || "")
    );
  });
}

export function buildLoadingState(connections) {
  const nextLoadingState = {};
  connections.forEach((connection) => {
    nextLoadingState[connection.id] = true;
  });
  return nextLoadingState;
}

export function filterQuotaStateByConnections(state, connections) {
  const visibleIds = new Set(connections.map((connection) => connection.id));
  return Object.fromEntries(
    Object.entries(state).filter(([id]) => visibleIds.has(id)),
  );
}

export function getConnectionsPageRange(pagination) {
  if (!pagination.total) {
    return { start: 0, end: 0 };
  }
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
  return { start, end };
}

export function getConnectionsEmptyMessage(totals, providerFilter, accountFilter) {
  if (!totals.eligibleConnections) {
    return {
      icon: "cloud_off",
      title: "No Providers Connected",
      description:
        "Connect to providers with OAuth to track your API quota limits and usage.",
    };
  }
  if (!totals.providerFilteredConnections) {
    return {
      icon: "filter_alt_off",
      title: "No Accounts Match Current Filters",
      description:
        providerFilter === "all"
          ? "Try changing the account status filter to see more quota trackers."
          : `No ${accountFilter === "inactive" ? "turned off" : accountFilter === "active" ? "active" : "matching"} accounts found for ${providerFilter}.`,
    };
  }
  return {
    icon: "filter_alt_off",
    title: "No Accounts On This Page",
    description:
      "Try moving to another page or refreshing the current filters.",
  };
}

export function sortRequestFromExpiringFirst(expiringFirst) {
  return expiringFirst ? "expiring" : "priority";
}

export function getPageSizeLabel(pageSize, isCustomPageSize) {
  return isCustomPageSize ? `Custom: ${pageSize} / page` : `${pageSize} / page`;
}

export function getConnectionsPaginationSummary(pagination) {
  const { start, end } = getConnectionsPageRange(pagination);
  return `Showing ${start}-${end} of ${pagination.total}`;
}

export function getSafePagination(pagination, fallbackPageSize) {
  return (
    pagination || {
      page: 1,
      pageSize: fallbackPageSize,
      total: 0,
      totalPages: 1,
    }
  );
}

export function getSafeTotals(totals, fallbackTotal = 0) {
  return (
    totals || {
      eligibleConnections: fallbackTotal,
      providerFilteredConnections: fallbackTotal,
    }
  );
}

export function shouldResetPage(previousValue, nextValue) {
  return previousValue !== nextValue;
}

export function getPaginationPageValue(dataPagination, fallbackPage) {
  return dataPagination?.page || fallbackPage;
}

export function getProviderOptions(dataProviderOptions) {
  return dataProviderOptions || [];
}

export async function reconcileConnectionsPage(fetchConnections, targetPage) {
  return await fetchConnections(targetPage);
}

export function getQuotaCache() {
  if (typeof window === "undefined") return {};
  try {
    const cached = window.localStorage.getItem(QUOTA_CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch (error) {
    console.error("Error reading quota cache:", error);
    return {};
  }
}

export function setQuotaCache(connectionId, quotaEntry) {
  if (typeof window === "undefined") return;
  try {
    const cache = getQuotaCache();
    cache[connectionId] = {
      ...quotaEntry,
      cachedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.error("Error writing quota cache:", error);
  }
}

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate - now;

    if (!Number.isFinite(diffMs) || diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));
    
    // < 60 minutes: show only minutes
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    
    // < 24 hours: show hours and minutes
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }
    
    // >= 24 hours: show days, hours, and minutes
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch (error) {
    return "-";
  }
}

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage > 70) return "green";
  if (percentage >= 30) return "yellow";
  return "red"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage > 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  const value = quotaRemainingPercent({ used, total });
  return value === null ? null : Math.round(value);
}

export function getRemainingPercentage(quota) {
  const value = quotaRemainingPercent(quota);
  return value === null ? null : Math.round(value);
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider, data) {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas = [];

  if (data.quotas && typeof data.quotas === "object") {
    for (const [key, quota] of Object.entries(data.quotas)) {
      if (!quota || typeof quota !== "object") continue;
      if (provider === "qoder" && key === "organization" && !(quotaNumber(quota.total) > 0)) continue;
      const name = provider === "qoder" ? key === "user" ? "Personal" : key === "organization" ? "Organization" : key : quota.displayName || key;
      normalizedQuotas.push({
        ...quota,
        name,
        modelKey: key,
        used: quotaNumber(quota.used),
        total: quotaNumber(quota.total),
        remaining: quotaNumber(quota.remaining),
        remainingPercentage: quotaNumber(quota.remainingPercentage),
        resetAt: quota.resetAt || null,
        observedAt: data.observedAt || null,
        stale: data.stale === true,
        recurring: quota.recurring !== false,
      });
    }
  }

  // Sort quotas according to PROVIDER_MODELS order
  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]));
    
    normalizedQuotas.sort((a, b) => {
      // Use modelKey for antigravity, otherwise use name
      const keyA = a.modelKey || a.name;
      const keyB = b.modelKey || b.name;
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}
