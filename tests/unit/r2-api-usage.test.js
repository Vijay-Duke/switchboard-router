import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUsageStats: vi.fn(),
  getChartData: vi.fn(),
  getRecentLogs: vi.fn(),
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  getExecutor: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  hasValidCliToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getUsageStats: mocks.getUsageStats,
  getChartData: mocks.getChartData,
  getRecentLogs: mocks.getRecentLogs,
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: mocks.getExecutor }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));

const historyRoute = await import("../../src/app/api/usage/history/route.js");
const logsRoute = await import("../../src/app/api/usage/logs/route.js");
const requestLogsRoute = await import("../../src/app/api/usage/request-logs/route.js");
const chartRoute = await import("../../src/app/api/usage/chart/route.js");
const statsRoute = await import("../../src/app/api/usage/stats/route.js");
const connRoute = await import("../../src/app/api/usage/[connectionId]/route.js");
const mgmtUsageRoute = await import("../../src/app/api/mgmt/v1/usage/route.js");

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const readSrc = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

describe("GET /api/usage/history period filter (A19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUsageStats.mockResolvedValue({ totalRequests: 1 });
  });

  it("passes ?period= through to getUsageStats", async () => {
    const res = await historyRoute.GET(new Request("http://localhost:20128/api/usage/history?period=30d"));
    expect(res.status).toBe(200);
    expect(mocks.getUsageStats).toHaveBeenCalledWith("30d");
  });

  it("defaults to 7d", async () => {
    await historyRoute.GET(new Request("http://localhost:20128/api/usage/history"));
    expect(mocks.getUsageStats).toHaveBeenCalledWith("7d");
  });

  it("400s on an invalid period", async () => {
    const res = await historyRoute.GET(new Request("http://localhost:20128/api/usage/history?period=banana"));
    expect(res.status).toBe(400);
    expect(mocks.getUsageStats).not.toHaveBeenCalled();
  });
});

describe("usage log limit (A20/A21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecentLogs.mockImplementation(async (limit) => Array.from({ length: limit }, (_, i) => `row-${i}`));
  });

  it.each([
    ["logs", logsRoute],
    ["request-logs", requestLogsRoute],
  ])("%s honors ?limit=", async (_name, route) => {
    const res = await route.GET(new Request("http://localhost:20128/api/usage/x?limit=5"));
    expect(res.status).toBe(200);
    expect(mocks.getRecentLogs).toHaveBeenCalledWith(5);
    expect(await res.json()).toHaveLength(5);
  });

  it("defaults to 200 and clamps to 1..500", async () => {
    await logsRoute.GET(new Request("http://localhost:20128/api/usage/logs"));
    expect(mocks.getRecentLogs).toHaveBeenCalledWith(200);
    await logsRoute.GET(new Request("http://localhost:20128/api/usage/logs?limit=5000"));
    expect(mocks.getRecentLogs).toHaveBeenCalledWith(500);
  });

  it("both routes export force-dynamic", () => {
    expect(readSrc("src/app/api/usage/logs/route.js")).toContain('export const dynamic = "force-dynamic"');
    expect(readSrc("src/app/api/usage/request-logs/route.js")).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("usage period agreement (A22)", () => {
  const originalHostname = process.env.HOSTNAME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getChartData.mockImplementation(async (period) => [{ label: period }]);
    mocks.getUsageStats.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  it.each(["today", "24h", "7d", "30d", "60d", "all"])("chart accepts period %s", async (period) => {
    const res = await chartRoute.GET(new Request(`http://localhost:20128/api/usage/chart?period=${period}`));
    expect(res.status).toBe(200);
    expect(mocks.getChartData).toHaveBeenCalledWith(period);
  });

  it("chart still 400s on garbage", async () => {
    const res = await chartRoute.GET(new Request("http://localhost:20128/api/usage/chart?period=forever"));
    expect(res.status).toBe(400);
  });

  it("stats, history, and mgmt usage accept the same period list", async () => {
    for (const period of ["today", "24h", "7d", "30d", "60d", "all"]) {
      const s = await statsRoute.GET(new Request(`http://localhost:20128/api/usage/stats?period=${period}`));
      expect(s.status).toBe(200);
      const h = await historyRoute.GET(new Request(`http://localhost:20128/api/usage/history?period=${period}`));
      expect(h.status).toBe(200);
      const m = await mgmtUsageRoute.GET(
        new Request(`http://localhost:20128/api/mgmt/v1/usage?period=${period}`, {
          headers: { host: "localhost:20128" },
        }),
      );
      expect(m.status).toBe(200);
    }
  });
});

describe("GET /api/usage/[connectionId] errors (A23/A24)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  function getConn(id, search = "") {
    return new Request(`http://localhost:20128/api/usage/${id}${search}`, {
      headers: { host: "localhost:20128" },
    });
  }

  it("A24: empty/oversize connectionId returns 400 without a DB call", async () => {
    const res = await connRoute.GET(getConn(""), { params: Promise.resolve({ connectionId: "" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid connection id" });
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("A23: ineligible connection returns 400 {error}, not 200 {message}", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "c1",
      provider: "openai",
      authType: "apikey",
    });
    const res = await connRoute.GET(getConn("c1"), { params: Promise.resolve({ connectionId: "c1" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Usage not available for this connection" });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("A23: refresh failure returns a generic 401", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "c2",
      provider: "anthropic",
      authType: "oauth",
      accessToken: "a",
      refreshToken: "r",
    });
    mocks.getExecutor.mockReturnValue({
      needsRefresh: () => true,
      refreshCredentials: async () => {
        throw new Error("token endpoint says: boom");
      },
    });
    const res = await connRoute.GET(getConn("c2"), { params: Promise.resolve({ connectionId: "c2" }) });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("boom");
  });

  it("A23: unexpected failure returns a generic 500", async () => {
    mocks.getProviderConnectionById.mockRejectedValue(new Error("sqlite: boom"));
    const res = await connRoute.GET(getConn("c3"), { params: Promise.resolve({ connectionId: "c3" }) });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({ error: "Failed to fetch usage" });
  });
});
