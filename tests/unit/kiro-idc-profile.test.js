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

  it("discovers and persists the profile ARN when the user does not supply one", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 3600,
        }), { status: 200 });
      }
      if (String(url).includes("q.eu-central-1.amazonaws.com")) {
        return new Response(JSON.stringify({
          profiles: [{ arn: PROFILE_ARN }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { pollForToken } = await import("../../src/lib/oauth/providers.js");

    const result = await pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
      _startUrl: "https://example.awsapps.com/start/",
    });

    expect(result.tokens.providerSpecificData.profileArn).toBe(PROFILE_ARN);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://q.eu-central-1.amazonaws.com",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        }),
      }),
    );
  });

  it("rejects an invalid manually supplied profile ARN", async () => {
    const { pollForToken } = await import("../../src/lib/oauth/providers.js");

    await expect(pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
      _profileArn: "not-an-arn",
    })).rejects.toThrow("A valid Kiro profile ARN is required");
  });

  it("explains when an IDC account has no discoverable enterprise profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 3600,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    }));
    const { pollForToken } = await import("../../src/lib/oauth/providers.js");

    await expect(pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
    })).rejects.toThrow("Kiro did not return an enterprise profile");
  });

  it("uses the regional FIPS endpoint for GovCloud profile discovery", async () => {
    const govProfileArn =
      "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/GOVPROFILE";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profiles: [{ arn: govProfileArn }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");

    const profileArn = await fetchKiroProfileArn("access-token", "us-gov-west-1");

    expect(profileArn).toBe(govProfileArn);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://q-fips.us-gov-west-1.amazonaws.com",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
