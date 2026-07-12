// @ts-check
import { getProviderConnections, getUsageStats } from "@/lib/db/index.js";
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export const dynamic = "force-dynamic";

/** @param {Request} request */
function getPeriod(request) {
  const period = new URL(request.url).searchParams.get("period") || "7d";
  return VALID_PERIODS.has(period) ? period : null;
}

/** @param {Record<string, any>} connection */
function toQuotaConnection(connection) {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    rateLimitedUntil: connection.rateLimitedUntil,
    testStatus: connection.testStatus,
  };
}

/** GET /api/mgmt/v1/usage?period=today|24h|7d|30d|60d|all */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const period = getPeriod(request);
    if (!period) return fail(400, "Invalid period");
    const [usage, connections] = await Promise.all([
      getUsageStats(period), getProviderConnections(),
    ]);
    return ok({
      period,
      usage,
      quota: { connections: connections.map(toQuotaConnection) },
    });
  } catch {
    return fail(500, "Failed to fetch usage");
  }
}
