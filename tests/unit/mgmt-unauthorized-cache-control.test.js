/**
 * QA-005 — unauthorized management API responses (middleware branch and the
 * route-level defense-in-depth in _lib/http.js) must carry Cache-Control:
 * no-store, matching the management success/error contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  hasValidCliToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => ({ ok: true, next: true })),
    json: vi.fn((body, init = {}) =>
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: init.headers || {},
      })
    ),
    redirect: vi.fn((url) => new Response(null, { status: 307, headers: { Location: url } })),
  },
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/cliToken.js", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
}));

const { proxy } = await import("../../src/dashboardGuard.js");
const { requireManagementAuth } = await import("../../src/app/api/mgmt/v1/_lib/http.js");

function guardRequest(pathname, headers = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: new Headers(headers),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  mocks.validateApiKey.mockResolvedValue(false);
  mocks.hasValidCliToken.mockResolvedValue(false);
  delete process.env.SWITCHBOARD_TRUST_REAL_IP;
  delete process.env.SWITCHBOARD_LOCAL_PEERS;
  process.env.HOSTNAME = "127.0.0.1"; // loopback bind, like npm scripts
});

describe("middleware /api/mgmt 401 cache policy (QA-005)", () => {
  it("non-local origin without credentials gets 401 {v:1,error} + Cache-Control: no-store", async () => {
    const res = await proxy(
      guardRequest("/api/mgmt/v1/health", {
        host: "127.0.0.1:20128",
        origin: "http://qa-nonlocal.invalid",
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(await res.text());
    expect(body.v).toBe(1);
    expect(body.error.message).toBe("Management API: unauthorized");
  });

  it("a valid gateway API key is not management auth — 401 still carries no-store", async () => {
    mocks.validateApiKey.mockResolvedValue(true);
    const res = await proxy(
      guardRequest("/api/mgmt/v1/health", {
        host: "127.0.0.1:20128",
        origin: "http://qa-nonlocal.invalid",
        authorization: "Bearer sk-switchboard-ordinary-gateway-key",
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("authorized local management request passes through untouched", async () => {
    const res = await proxy(guardRequest("/api/mgmt/v1/health", { host: "127.0.0.1:20128" }));
    expect(res.next).toBe(true);
  });
});

describe("route-level requireManagementAuth 401 cache policy (QA-005)", () => {
  it("non-local request without a token returns 401 + Cache-Control: no-store", async () => {
    const request = new Request("http://127.0.0.1:20128/api/mgmt/v1/health", {
      headers: { host: "127.0.0.1:20128", origin: "http://qa-nonlocal.invalid" },
    });

    const denied = await requireManagementAuth(request);
    expect(denied).toBeInstanceOf(Response);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const body = JSON.parse(await denied.text());
    expect(body.v).toBe(1);
    expect(body.error.code).toBe("unauthorized");
  });
});
