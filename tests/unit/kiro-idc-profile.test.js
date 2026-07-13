import { afterEach, describe, expect, it, vi } from "vitest";

const PROFILE_ARN =
  "arn:aws:codewhisperer:eu-central-1:123456789012:profile/PROFILE";

describe("Kiro IAM Identity Center profile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists the supplied profile ARN separately from the login region", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }), { status: 200 })));
    const { pollForToken } = await import("../../src/lib/oauth/providers.js");

    const result = await pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
      _startUrl: "https://example.awsapps.com/start/",
      _profileArn: PROFILE_ARN,
    });

    expect(result.tokens.providerSpecificData).toMatchObject({
      authMethod: "idc",
      region: "eu-west-1",
      profileArn: PROFILE_ARN,
    });
  });

  it("rejects IDC polling without a valid profile ARN", async () => {
    const { pollForToken } = await import("../../src/lib/oauth/providers.js");

    await expect(pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
      _profileArn: "not-an-arn",
    })).rejects.toThrow("A valid Kiro profile ARN is required");
  });
});
