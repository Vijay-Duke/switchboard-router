// Upstream f6e7cabe / 88676b30: ClinePass API keys must not be workos:-prefixed,
// and Cline/ClinePass OAuth tokens refresh via the extension JSON contract.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getClineAccessToken,
  getClineAuthorizationHeader,
} from "../../open-sse/shared/clineAuth.js";

describe("getClineAccessToken", () => {
  it("keeps an existing workos: prefix", () => {
    const token = "workos:eyJhbGciOiJSUzI1NiJ9.eyJwYXAiJ9";
    expect(getClineAccessToken(token)).toBe(token);
    expect(getClineAccessToken(`  ${token}  `)).toBe(token);
  });

  it("prefixes a bare WorkOS JWT with workos:", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJwYXAiJ9";
    expect(getClineAccessToken(jwt)).toBe(`workos:${jwt}`);
  });

  it("does NOT prefix ClinePass API keys or opaque tokens", () => {
    expect(getClineAccessToken("clp_1234567890abcdef")).toBe("clp_1234567890abcdef");
    expect(getClineAccessToken("sk-sb-abcdef")).toBe("sk-sb-abcdef");
    expect(getClineAccessToken("")).toBe("");
    expect(getClineAccessToken("   ")).toBe("");
    expect(getClineAccessToken(undefined)).toBe("");
    expect(getClineAccessToken(null)).toBe("");
  });

  it("builds a Bearer header without double prefixing", () => {
    expect(getClineAuthorizationHeader("clp_abc")).toBe("Bearer clp_abc");
    expect(getClineAuthorizationHeader("eyJpeg.eyJbG")).toBe("Bearer workos:eyJpeg.eyJbG");
    expect(getClineAuthorizationHeader("workos:eyJpeg.eyJbG")).toBe("Bearer workos:eyJpeg.eyJbG");
  });
});

describe("Cline / ClinePass refresh via refreshTokenByProvider", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
  });
  afterEach(() => vi.doUnmock("../../open-sse/utils/proxyFetch.js"));

  for (const provider of ["cline", "clinepass"]) {
    it(`${provider}: uses the extension JSON refresh contract`, async () => {
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        data: { accessToken: "cline-acc", refreshToken: "cline-rot", expiresAt },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");

      const out = await refreshTokenByProvider(provider, { refreshToken: `${provider}-old` }, null);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.cline.bot/api/v1/auth/refresh");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({
        refreshToken: `${provider}-old`,
        grantType: "refresh_token",
        clientType: "extension",
      });
      expect(out).toMatchObject({ accessToken: "cline-acc", refreshToken: "cline-rot" });
      expect(out.expiresIn).toBeGreaterThan(0);
    });
  }
});
