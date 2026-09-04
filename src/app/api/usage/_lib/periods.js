// @ts-check

/**
 * Periods accepted by every usage endpoint (dashboard `/api/usage/*` and
 * management `/api/mgmt/v1/usage`). Single source of truth so one dashboard
 * period picker works against stats, chart, and history alike.
 */
export const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const DEFAULT_PERIOD = "7d";
