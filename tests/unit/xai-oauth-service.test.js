import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
import { XaiService, discoverEndpoints, validateOAuthEndpoint } from "../../src/lib/oauth/services/xai.js";
import { exchangeTokens, generateAuthData } from "../../src/lib/oauth/providers.js";

describe("xai/oauth service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    proxyAwareFetch.mockReset();
  });

  it("validates discovered endpoints are https x.ai URLs", async () => {
    expect(validateOAuthEndpoint("https://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toBe(
      "https://auth.x.ai/oauth2/authorize"
    );
    expect(() => validateOAuthEndpoint("http://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toThrow(
      /must use https/
    );
    expect(() => validateOAuthEndpoint("https://example.com/oauth2/authorize", "authorization_endpoint")).toThrow(
      /is not on x\.ai/
    );
  });

  it("discovers endpoints without custom user-agent headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    });

    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://auth.x.ai/.well-known/openid-configuration",
      {
        headers: { Accept: "application/json" },
        identity: "grok-cli",
        provider: "xai",
        format: "openai",
      }
    );
  });

  it("builds authorize URLs with CLIProxyAPI query extras", async () => {
    const authUrl = new XaiService().buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      "https://auth.x.ai/oauth2/authorize"
    );
    const parsed = new URL(authUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("generates dashboard auth data with CLIProxyAPI PKCE size and discovered endpoints", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://auth.x.ai/oauth2/authorize-from-discovery",
            token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
          }),
        };
      }
      throw new Error(`Unexpected xAI OAuth URL: ${url}`);
    });

    const data = await generateAuthData("xai", "http://127.0.0.1:56121/callback");
    const parsed = new URL(data.authUrl);

    expect(data.codeVerifier).toHaveLength(128);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize-from-discovery");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");

    const discoveryCall = proxyAwareFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/.well-known/openid-configuration")
    );
    if (discoveryCall) {
      expect(discoveryCall).toEqual([
        "https://auth.x.ai/.well-known/openid-configuration",
        {
          headers: { Accept: "application/json" },
          identity: "grok-cli",
          provider: "xai",
          format: "openai",
        },
      ]);
    }
  });

  it("exchanges dashboard codes against the discovered xAI token endpoint", async () => {
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
            token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
          }),
        };
      }
      if (String(url).includes("/oauth2/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
          }),
        };
      }
      throw new Error(`Unexpected xAI OAuth URL: ${url}`);
    });

    const tokens = await exchangeTokens(
      "xai",
      "auth-code",
      "http://127.0.0.1:56121/callback",
      "verifier-1",
      "state-1"
    );

    const discoveryCall = proxyAwareFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/.well-known/openid-configuration")
    );
    if (discoveryCall) {
      expect(discoveryCall).toEqual([
        "https://auth.x.ai/.well-known/openid-configuration",
        {
          headers: { Accept: "application/json" },
          identity: "grok-cli",
          provider: "xai",
          format: "openai",
        },
      ]);
    }

    const tokenCall = proxyAwareFetch.mock.calls.find(([url]) =>
      String(url).startsWith("https://auth.x.ai/oauth2/token")
    );
    expect(tokenCall).toEqual([
      expect.stringMatching(/^https:\/\/auth\.x\.ai\/oauth2\/token(?:-from-discovery)?$/),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: expect.any(URLSearchParams),
        identity: "grok-cli",
        provider: "xai",
        format: "openai",
      },
    ]);
    expect(tokenCall[1].body.get("grant_type")).toBe("authorization_code");
    expect(tokenCall[1].body.get("code")).toBe("auth-code");
    expect(tokenCall[1].body.get("code_verifier")).toBe("verifier-1");
    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    });
  });
});
