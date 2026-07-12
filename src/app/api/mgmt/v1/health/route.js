// @ts-check
import { getProviderConnections, getSettings } from "@/lib/db/index.js";
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

export const dynamic = "force-dynamic";

/** @param {Record<string, any>[]} connections */
function summarizeProviders(connections) {
  const now = Date.now();
  let okCount = 0;
  let error = 0;
  let rateLimited = 0;
  for (const connection of connections) {
    if (["ok", "success", "valid"].includes(connection.testStatus)) okCount += 1;
    if (["error", "invalid"].includes(connection.testStatus)) error += 1;
    if (new Date(connection.rateLimitedUntil).getTime() > now) rateLimited += 1;
  }
  return { total: connections.length, ok: okCount, error, rateLimited };
}

/** Check whether the local database can service a normal settings read. */
async function checkDb() {
  try {
    return Boolean(await getSettings());
  } catch {
    return false;
  }
}

/** GET /api/mgmt/v1/health */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const [dbOk, connections] = await Promise.all([checkDb(), getProviderConnections()]);
    return ok({
      status: dbOk ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      db: { ok: dbOk },
      providers: summarizeProviders(connections),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return fail(500, "Failed to fetch health");
  }
}
