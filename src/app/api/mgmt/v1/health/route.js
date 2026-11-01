// @ts-check
import { getProviderConnections, getSettings } from "@/lib/db/index.js";
import { getObservabilityBufferStats } from "@/lib/db/repos/requestDetailsRepo.js";
import { getLastMemorySnapshot } from "@/lib/memoryWatchdog.js";
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
    const observability = getObservabilityBufferStats();
    const memory = getLastMemorySnapshot();
    return ok({
      status: dbOk ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      db: { ok: dbOk },
      // Heap visibility for OOM triage (2026-11-01): heapFraction near 1.0
      // means a watchdog restart / V8 abort is imminent.
      memory: memory ? {
        rssBytes: memory.rssBytes,
        heapUsedBytes: memory.heapUsedBytes,
        heapTotalBytes: memory.heapTotalBytes,
        heapLimitBytes: memory.heapLimitBytes,
        externalBytes: memory.externalBytes,
        arrayBuffersBytes: memory.arrayBuffersBytes,
        heapFraction: Number(memory.heapFraction.toFixed(4)),
      } : null,
      observability: {
        buffered: observability.buffered,
        maxBuffer: observability.maxBuffer,
        droppedTotal: observability.droppedTotal,
      },
      providers: summarizeProviders(connections),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return fail(500, "Failed to fetch health");
  }
}
