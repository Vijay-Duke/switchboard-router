const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
const { pollForToken } = await import("../../src/lib/oauth/providers.js");
const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROFILE_ARN =
  "arn:aws:codewhisperer:eu-central-1:123456789012:profile/PROFILE";

describe("Kiro IAM Identity Center profile", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    proxyAwareFetch.mockReset();
  });

  it("persists the supplied profile ARN separately from the login region", async () => {
    const fetchMock = proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url) !== "https://oidc.eu-west-1.amazonaws.com/token") {
        throw new Error(`Unexpected Kiro URL: ${url}`);
      }
      return new Response(JSON.stringify({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      }), { status: 200 });
    });

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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oidc.eu-west-1.amazonaws.com/token",
      expect.objectContaining({
        method: "POST",
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
      }),
    );
  });

  it("discovers and persists the profile ARN when the user does not supply one", async () => {
    const fetchMock = proxyAwareFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target === "https://oidc.eu-west-1.amazonaws.com/token") {
        return new Response(JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 3600,
        }), { status: 200 });
      }
      if (target === "https://q.us-east-1.amazonaws.com") {
        return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
      }
      if (target === "https://q.eu-central-1.amazonaws.com") {
        return new Response(JSON.stringify({
          profiles: [{ arn: PROFILE_ARN }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected Kiro URL: ${url}`);
    });

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
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
        headers: expect.objectContaining({
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid manually supplied profile ARN", async () => {

    await expect(pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
      _profileArn: "not-an-arn",
    })).rejects.toThrow("A valid Kiro profile ARN is required");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("explains when an IDC account has no discoverable enterprise profile", async () => {
    const fetchMock = proxyAwareFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target === "https://oidc.eu-west-1.amazonaws.com/token") {
        return new Response(JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 3600,
        }), { status: 200 });
      }
      if ([
        "https://q.us-east-1.amazonaws.com",
        "https://q.eu-central-1.amazonaws.com",
        "https://codewhisperer.us-east-1.amazonaws.com",
      ].includes(target)) {
        return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
      }
      throw new Error(`Unexpected Kiro URL: ${url}`);
    });

    await expect(pollForToken("kiro", "device-code", null, {
      _clientId: "client-id",
      _clientSecret: "client-secret",
      _region: "eu-west-1",
      _authMethod: "idc",
    })).rejects.toThrow("Kiro did not return an enterprise profile");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://q.us-east-1.amazonaws.com",
      expect.objectContaining({
        method: "POST",
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://q.eu-central-1.amazonaws.com",
      expect.objectContaining({
        method: "POST",
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
      }),
    );
  });

  it("uses the regional FIPS endpoint for GovCloud profile discovery", async () => {
    const govProfileArn =
      "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/GOVPROFILE";
    const fetchMock = proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url) !== "https://q-fips.us-gov-west-1.amazonaws.com") {
        throw new Error(`Unexpected Kiro URL: ${url}`);
      }
      return new Response(JSON.stringify({
        profiles: [{ arn: govProfileArn }],
      }), { status: 200 });
    });

    const profileArn = await fetchKiroProfileArn("access-token", "us-gov-west-1");
    expect(profileArn).toBe(govProfileArn);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://q-fips.us-gov-west-1.amazonaws.com",
      expect.objectContaining({
        method: "POST",
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
      }),
    );
  });
});
