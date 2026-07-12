import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
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
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));

const { __test__ } = await import("../../src/dashboardGuard.js");
const { requireManagementAuth } = await import("../../src/app/api/mgmt/v1/_lib/http.js");

function request(host, authorization) {
  const headers = { host };
  if (authorization) headers.authorization = authorization;
  return new Request("http://localhost:20128/api/mgmt/v1/providers", { headers });
}

describe("management API authentication", () => {
  const originalHostname = process.env.HOSTNAME;
  const originalManagementToken = process.env.MANAGEMENT_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HOSTNAME = "127.0.0.1";
    delete process.env.MANAGEMENT_TOKEN;
    mocks.hasValidCliToken.mockResolvedValue(false);
  });

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
    if (originalManagementToken === undefined) delete process.env.MANAGEMENT_TOKEN;
    else process.env.MANAGEMENT_TOKEN = originalManagementToken;
  });

  it("validates only an exact configured management bearer token", () => {
    expect(__test__.isManagementTokenValid(request("router.example.com", "Bearer management-secret"))).toBe(false);
    process.env.MANAGEMENT_TOKEN = "management-secret";
    expect(__test__.isManagementTokenValid(request("router.example.com", "Bearer wrong-secret"))).toBe(false);
    expect(__test__.isManagementTokenValid(request("router.example.com", "Bearer management-secret"))).toBe(true);
  });

  it("allows local management requests but requires the configured token remotely", async () => {
    expect(await __test__.canAccessManagementRoute(request("localhost:20128"))).toBe(true);
    expect(await __test__.canAccessManagementRoute(request("router.example.com"))).toBe(false);

    process.env.MANAGEMENT_TOKEN = "management-secret";
    expect(await __test__.canAccessManagementRoute(request("router.example.com", "Bearer wrong-secret"))).toBe(false);
    expect(await __test__.canAccessManagementRoute(request("router.example.com", "Bearer management-secret"))).toBe(true);
  });

  it("returns the management error envelope only for unauthorized remote requests", async () => {
    expect(await requireManagementAuth(request("localhost:20128"))).toBeNull();

    const denied = await requireManagementAuth(request("router.example.com", "Bearer wrong-secret"));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      v: 1,
      error: {
        message: "Management API requires local access or a valid bearer token",
        code: "unauthorized",
      },
    });

    process.env.MANAGEMENT_TOKEN = "management-secret";
    expect(await requireManagementAuth(request("router.example.com", "Bearer management-secret"))).toBeNull();
  });
});
