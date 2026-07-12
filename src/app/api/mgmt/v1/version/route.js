// @ts-check
import pkg from "../../../../../../package.json" with { type: "json" };
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

export const dynamic = "force-dynamic";

/** GET /api/mgmt/v1/version */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    return ok({
      name: pkg.name,
      version: pkg.version,
      apiVersion: 1,
      node: process.version,
      platform: process.platform,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    });
  } catch {
    return fail(500, "Failed to read version");
  }
}
