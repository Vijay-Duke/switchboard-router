import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireManagementAuth: vi.fn(),
  collectPrometheusMetrics: vi.fn(),
}));

vi.mock("@/app/api/mgmt/v1/_lib/http.js", () => ({
  requireManagementAuth: mocks.requireManagementAuth,
  fail(status, message, code) {
    return new Response(JSON.stringify({ v: 1, error: { message, code } }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
}));

vi.mock("@/lib/metrics/prometheus.js", () => ({
  prometheusMetricsEnabled: (env = process.env) => env.PROMETHEUS_METRICS_ENABLED === "true",
  collectPrometheusMetrics: mocks.collectPrometheusMetrics,
}));

const route = await import("../../src/app/api/mgmt/v1/metrics/route.js");
const originalEnabled = process.env.PROMETHEUS_METRICS_ENABLED;
const request = () => new Request("http://localhost:20128/api/mgmt/v1/metrics");

describe("management Prometheus route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PROMETHEUS_METRICS_ENABLED;
    mocks.requireManagementAuth.mockResolvedValue(null);
    mocks.collectPrometheusMetrics.mockResolvedValue(
      "# HELP switchboard_active_requests Active.\n# TYPE switchboard_active_requests gauge\nswitchboard_active_requests 0\n",
    );
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.PROMETHEUS_METRICS_ENABLED;
    else process.env.PROMETHEUS_METRICS_ENABLED = originalEnabled;
  });

  it("returns auth denial before checking configuration or collecting", async () => {
    const denied = new Response("denied", { status: 401 });
    mocks.requireManagementAuth.mockResolvedValue(denied);
    const response = await route.GET(request());
    expect(response).toBe(denied);
    expect(mocks.collectPrometheusMetrics).not.toHaveBeenCalled();
  });

  it("returns an authenticated 404 while disabled", async () => {
    const response = await route.GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      v: 1,
      error: { message: "Prometheus metrics are disabled", code: "metrics_disabled" },
    });
    expect(mocks.collectPrometheusMetrics).not.toHaveBeenCalled();
  });

  it("returns Prometheus 0.0.4 text with no-store headers when enabled", async () => {
    process.env.PROMETHEUS_METRICS_ENABLED = "true";
    const response = await route.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("switchboard_active_requests 0\n");
  });

  it("returns a sanitized 503 and no partial text when collection fails", async () => {
    process.env.PROMETHEUS_METRICS_ENABLED = "true";
    mocks.collectPrometheusMetrics.mockRejectedValue(new Error("SECRET database path"));
    const response = await route.GET(request());
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      v: 1,
      error: { message: "Prometheus metrics are unavailable", code: "metrics_unavailable" },
    });
    expect(text).not.toContain("SECRET database path");
    expect(text).not.toContain("# HELP");
  });
});
