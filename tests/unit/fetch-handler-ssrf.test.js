import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPublicUrl: vi.fn(),
  assertPublicUrlResolved: vi.fn(),
  authorize: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
  assertPublicUrlResolved: mocks.assertPublicUrlResolved,
}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: mocks.getSettings,
  getCombos: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: mocks.authorize,
  runWithClientKeyLease: (_lease, fn) => fn(),
}));

const { handleFetch } = await import("../../src/sse/handlers/fetch.js");

const jsonRequest = (body) => new Request("https://router.test/v1/web/fetch", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer k" },
  body: JSON.stringify(body),
});

describe("handleFetch SSRF guards", () => {
  it("rejects sync-blocked URLs before DNS resolution", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.authorize.mockResolvedValue({ ok: true, lease: {}, clientKeyId: "k1" });
    mocks.assertPublicUrl.mockImplementation(() => { throw new Error("internal host blocked: 127.0.0.1"); });

    const res = await handleFetch(jsonRequest({ provider: "nope", url: "http://127.0.0.1/x" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("internal host blocked");
    expect(mocks.assertPublicUrlResolved).not.toHaveBeenCalled();
  });

  it("rejects URLs whose resolved IP is private", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.authorize.mockResolvedValue({ ok: true, lease: {}, clientKeyId: "k1" });
    mocks.assertPublicUrl.mockImplementation(() => {});
    mocks.assertPublicUrlResolved.mockRejectedValue(new Error("resolves to private address 10.0.0.5"));

    const res = await handleFetch(jsonRequest({ provider: "nope", url: "http://rebind.example/x" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("SSRF blocked: resolves to private address 10.0.0.5");
  });

  it("passes clean URLs through to routing and forwards allow-hosts from settings", async () => {
    mocks.getSettings.mockResolvedValue({ ssrfAllowHosts: ["gateway.internal"] });
    mocks.authorize.mockResolvedValue({ ok: true, lease: {}, clientKeyId: "k1" });
    mocks.assertPublicUrl.mockImplementation(() => {});
    mocks.assertPublicUrlResolved.mockResolvedValue(undefined);

    const res = await handleFetch(jsonRequest({ provider: "nope", url: "https://gateway.internal/x" }));
    // Flow continued past both guards into provider routing.
    expect(await res.text()).toContain("Unknown provider: nope");
    expect(mocks.assertPublicUrlResolved).toHaveBeenCalledWith("https://gateway.internal/x", ["gateway.internal"]);
  });
});
