import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async (salt) => `machine-secret:${salt}`),
}));

const {
  createDashboardSessionToken,
  verifyDashboardSessionToken,
  hasValidDashboardSession,
  dashboardSessionCookieAttributes,
  __resetDashboardSessionCacheForTests,
} = await import("../../src/lib/auth/dashboardSession.js");

function requestWithCookie(cookie) {
  return {
    headers: new Headers({ cookie }),
    cookies: { get: (name) => (name === "switchboard_session" ? { value: cookie.split("=")[1] } : undefined) },
  };
}

describe("dashboard session token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips a freshly minted token", async () => {
    const token = await createDashboardSessionToken();
    expect(await verifyDashboardSessionToken(token)).toBe(true);
    expect(await hasValidDashboardSession(requestWithCookie(`switchboard_session=${token}`))).toBe(true);
  });

  it("rejects tampered payloads and bad formats", async () => {
    const token = await createDashboardSessionToken();
    const [, exp, sig] = token.split(".");
    const tamperedExp = `v1.${Number(exp) + 86_400_000}.${sig}`; // extend expiry, keep sig
    expect(await verifyDashboardSessionToken(tamperedExp)).toBe(false);
    expect(await verifyDashboardSessionToken(`${token}x`)).toBe(false);
    expect(await verifyDashboardSessionToken("v1.notanumber.deadbeef")).toBe(false);
    expect(await verifyDashboardSessionToken("")).toBe(false);
    expect(await verifyDashboardSessionToken(null)).toBe(false);
  });

  it("rejects expired tokens", async () => {
    const token = await createDashboardSessionToken(-1000); // already expired
    expect(await verifyDashboardSessionToken(token)).toBe(false);
  });

  it("binds to the machine secret — a different machine rejects the token", async () => {
    const token = await createDashboardSessionToken();
    const { getConsistentMachineId } = await import("@/shared/utils/machineId");
    __resetDashboardSessionCacheForTests();
    getConsistentMachineId.mockResolvedValue("another-machine");
    expect(await verifyDashboardSessionToken(token)).toBe(false);
    __resetDashboardSessionCacheForTests();
    getConsistentMachineId.mockImplementation((salt) => Promise.resolve(`machine-secret:${salt}`));
  });

  it("reads the cookie from the raw Cookie header when request.cookies is absent", async () => {
    const token = await createDashboardSessionToken();
    expect(await hasValidDashboardSession({ headers: new Headers({ cookie: `a=1; switchboard_session=${token}; b=2` }) })).toBe(true);
    expect(await hasValidDashboardSession({ headers: new Headers({}) })).toBe(false);
  });

  it("serializes cookie attributes with hardening flags", () => {
    const attrs = dashboardSessionCookieAttributes("tok", { secure: true });
    expect(attrs).toContain("switchboard_session=tok");
    expect(attrs).toContain("HttpOnly");
    expect(attrs).toContain("SameSite=Lax");
    expect(attrs).toContain("Path=/");
    expect(attrs).toContain("Secure");
    expect(attrs).toContain("Max-Age=604800");
    expect(dashboardSessionCookieAttributes("tok")).not.toContain("Secure"); // plain HTTP LAN stays usable
  });
});
