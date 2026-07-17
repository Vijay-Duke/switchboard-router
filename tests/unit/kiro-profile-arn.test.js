import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";

/**
 * Regression tests for Kiro API-key auth.
 *
 * KiroService.validateApiKey verifies a long-lived API key with a REAL
 * authenticated CodeWhisperer call (ListAvailableModels + `tokentype: API_KEY`)
 * and returns a credential shaped for persistence with authMethod="api_key".
 *
 * Why not ListAvailableProfiles: without `tokentype` it returns HTTP 200 + an
 * empty list for ANY string (false positive — a bogus key looked valid), and
 * with the header it 403s "API key authentication is not supported for this
 * operation" for every key. ListAvailableModels genuinely validates the bearer.
 *
 * profileArn is null for API-key connections (the operation that lists profiles
 * rejects API-key auth); the request translator sends an empty profileArn so
 * CodeWhisperer uses the token's own default.
 *
 * Note: OAuth (Builder ID / IDC) profileArn resolution is handled upstream by
 * fetchKiroProfileArn in providers.js and is covered there — not here.
 */
describe("kiro API-key auth (KiroService.validateApiKey)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("validates an API key with a real ListAvailableModels auth check", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ modelId: "claude-opus-4.8" }] }),
    });

    const svc = new KiroService();
    const cred = await svc.validateApiKey("  my-secret-key  ");

    expect(cred).toEqual({
      accessToken: "my-secret-key",
      refreshToken: null,
      profileArn: null,
      region: "us-east-1",
      authMethod: "api_key",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codewhisperer.us-east-1.amazonaws.com");
    expect(init.headers.Authorization).toBe("Bearer my-secret-key");
    expect(init.headers["x-amz-target"]).toBe(
      "AmazonCodeWhispererService.ListAvailableModels"
    );
    // The API-key marker header is required for CodeWhisperer to accept the bearer.
    expect(init.headers.tokentype).toBe("API_KEY");
  });

  it("treats a 400 (bearer accepted, arg check) as a valid key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"message":"missing profileArn"}',
    });
    const svc = new KiroService();
    const cred = await svc.validateApiKey("good-key");
    expect(cred.authMethod).toBe("api_key");
    expect(cred.accessToken).toBe("good-key");
  });

  it("rejects an empty API key without a network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(svc.validateApiKey("   ")).rejects.toMatchObject({
      code: "MISSING_KEY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a key AWS refuses (403 bearer invalid) with an AUTH_REJECTED code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        '{"message":"The bearer token included in the request is invalid."}',
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("bad-key")).rejects.toMatchObject({
      code: "AUTH_REJECTED",
    });
  });

  it("surfaces a clear region error when the CodeWhisperer host does not resolve", async () => {
    // Non-us-east-1 regions have no CodeWhisperer endpoint → DNS ENOTFOUND.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      })
    );
    const svc = new KiroService();
    await expect(svc.validateApiKey("some-key", "eu-west-1")).rejects.toMatchObject({
      code: "REGION_UNAVAILABLE",
    });
  });

  it("rejects a host-injecting region before any network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(
      svc.validateApiKey("some-key", "evil.com#")
    ).rejects.toThrow(/Invalid region/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
