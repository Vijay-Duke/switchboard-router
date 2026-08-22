// @ts-check
import { fail, requireManagementAuth } from "@/app/api/mgmt/v1/_lib/http.js";
import { collectPrometheusMetrics, prometheusMetricsEnabled } from "@/lib/metrics/prometheus.js";

export const dynamic = "force-dynamic";

/** GET /api/mgmt/v1/metrics */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  if (!prometheusMetricsEnabled()) {
    return fail(404, "Prometheus metrics are disabled", "metrics_disabled");
  }
  try {
    const body = await collectPrometheusMetrics();
    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return fail(503, "Prometheus metrics are unavailable", "metrics_unavailable");
  }
}
