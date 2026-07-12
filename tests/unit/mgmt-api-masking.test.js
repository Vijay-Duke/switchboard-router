import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getSettings: vi.fn(),
  getUsageStats: vi.fn(),
  isLocalRequest: vi.fn(),
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
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: mocks.getProviderNodes,
  getSettings: mocks.getSettings,
  getUsageStats: mocks.getUsageStats,
}));

vi.mock("@/models", () => ({
  redactSecrets(value) {
    const secretKeys = new Set(["accessToken", "refreshToken", "idToken", "apiKey"]);
    const redact = (item) => {
      if (Array.isArray(item)) return item.map(redact);
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(Object.entries(item)
        .filter(([key]) => !secretKeys.has(key))
        .map(([key, child]) => [key, redact(child)]));
    };
    return redact(value);
  },
}));

vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));

const providersRoute = await import("../../src/app/api/mgmt/v1/providers/route.js");
const healthRoute = await import("../../src/app/api/mgmt/v1/health/route.js");
const usageRoute = await import("../../src/app/api/mgmt/v1/usage/route.js");

const secrets = ["SECRET_ACCESS", "SECRET_REFRESH", "SECRET_APIKEY", "SECRET_ID"];

function localRequest(path) {
  return new Request(`http://localhost:20128${path}`, { headers: { host: "localhost:20128" } });
}

describe("management API credential masking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getProviderConnections.mockResolvedValue([{
      id: "connection-1",
      provider: "example",
      authType: "oauth",
      name: "Primary",
      apiKey: "SECRET_APIKEY",
      accessToken: "SECRET_ACCESS",
      refreshToken: "SECRET_REFRESH",
      idToken: "SECRET_ID",
      providerSpecificData: { accessToken: "SECRET_ACCESS" },
      testStatus: "ok",
    }]);
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue({});
    mocks.getUsageStats.mockResolvedValue({ totalTokens: 42 });
  });

  it("returns provider auth flags without returning any credential values", async () => {
    const response = await providersRoute.GET(localRequest("/api/mgmt/v1/providers"));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.data.providers[0].accounts[0]).toMatchObject({
      id: "connection-1",
      hasApiKey: true,
      hasOAuth: true,
      hasIdToken: true,
    });
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  it("does not expose credentials from local health or usage responses", async () => {
    const [health, usage] = await Promise.all([
      healthRoute.GET(localRequest("/api/mgmt/v1/health")),
      usageRoute.GET(localRequest("/api/mgmt/v1/usage?period=7d")),
    ]);
    const serialized = `${JSON.stringify(await health.json())}${JSON.stringify(await usage.json())}`;

    expect(health.status).toBe(200);
    expect(usage.status).toBe(200);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });
});
