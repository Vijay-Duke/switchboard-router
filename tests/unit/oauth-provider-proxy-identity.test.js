import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import {
  exchangeTokens,
  pollForToken,
  requestDeviceCode,
} from "../../src/lib/oauth/providers.js";
import { fetchKiroProfileArn } from "../../src/lib/oauth/providerHelpers.js";
import { OAuthService } from "../../src/lib/oauth/services/oauth.js";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";
import { KimchiService } from "../../src/lib/oauth/services/kimchi.js";
import { QoderService } from "../../src/lib/oauth/services/qoder.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

describe("dashboard OAuth provider fetch identity", () => {
  it.each([
    ["claude", "claude-cli", "claude", { access_token: "claude-access" }],
    ["codex", "codex-cli", "openai-responses", { access_token: "codex-access" }],
  ])("exchanges %s codes with its registry profile", async (provider, identity, format, payload) => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(payload));

    const tokens = await exchangeTokens(
      provider,
      "auth-code",
      "http://localhost/callback",
      "verifier",
      "state",
    );

    expect(tokens.accessToken).toBe(payload.access_token);
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ identity, provider, format }),
    );
  });

  it("uses the Gemini CLI profile for token, userinfo, and project probes", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: "gemini-access", refresh_token: "refresh" }))
      .mockResolvedValueOnce(jsonResponse({ email: "user@example.com" }))
      .mockResolvedValueOnce(jsonResponse({ cloudaicompanionProject: { id: "project-1" } }));

    const tokens = await exchangeTokens(
      "gemini-cli",
      "auth-code",
      "http://localhost/callback",
      "unused",
      "state",
    );

    expect(tokens).toMatchObject({ accessToken: "gemini-access", email: "user@example.com", projectId: "project-1" });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of proxyAwareFetch.mock.calls) {
      expect(init).toMatchObject({ identity: "gemini-cli", provider: "gemini-cli", format: "gemini-cli" });
    }
  });

  it("uses Qwen identity for both device-code calls", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ device_code: "device", user_code: "user" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "qwen-access" }));

    await requestDeviceCode("qwen", "challenge");
    const result = await pollForToken("qwen", "device", "verifier", {});

    expect(result.tokens.accessToken).toBe("qwen-access");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of proxyAwareFetch.mock.calls) {
      expect(init).toMatchObject({ identity: "qwen", provider: "qwen", format: "openai" });
    }
  });

  it("uses the ordinary registry profile for iFlow token and userinfo calls", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: "iflow-access" }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { apiKey: "key", email: "user@example.com" } }));

    const tokens = await exchangeTokens(
      "iflow",
      "auth-code",
      "http://localhost/callback",
      "unused",
      "state",
    );

    expect(tokens).toMatchObject({ accessToken: "iflow-access", apiKey: "key" });
    for (const [, init] of proxyAwareFetch.mock.calls) {
      expect(init).toMatchObject({ identity: "openai-node", provider: "iflow", format: "openai" });
    }
  });
});

describe("OAuth services fetch identity", () => {
  it("uses an explicit ordinary-provider profile in OAuthService", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ access_token: "access" }));
    const service = new OAuthService({ clientId: "client", tokenUrl: "https://example.com/token" }, "openai");

    await expect(service.exchangeCode("code", "http://localhost/callback", "verifier")).resolves.toEqual({
      access_token: "access",
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/token",
      expect.objectContaining({ identity: "openai-node", provider: "openai", format: "openai" }),
    );
  });

  it("keeps AWS headers while using the Kiro registry profile", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ clientId: "client", clientSecret: "secret" }));

    await new KiroService().registerClient();

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://oidc.us-east-1.amazonaws.com/client/register",
      expect.objectContaining({
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("uses the Kimchi registry profile for profile probes", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ name: "Kim", email: "kim@example.com", username: "kim" }));

    await expect(new KimchiService().fetchProfile("token")).resolves.toEqual({
      displayName: "Kim",
      email: "kim@example.com",
      username: "kim",
    });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ identity: "openai-node", provider: "kimchi", format: "openai" }),
    );
  });

  it("uses the Qoder registry profile without dropping its timeout signal or user-agent", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ token: "dt-token", user_id: "user-1", expires_in: 3600 }));

    await expect(new QoderService().pollDeviceToken({ nonce: "nonce", codeVerifier: "verifier" }))
      .resolves.toMatchObject({ status: "ok", accessToken: "dt-token" });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("nonce=nonce"),
      expect.objectContaining({
        identity: "openai-node",
        provider: "qoder",
        format: "openai",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ "User-Agent": "Go-http-client/2.0" }),
      }),
    );
  });

  it("uses Kiro identity for profile discovery and preserves AWS target headers", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE" }],
    }));

    await expect(fetchKiroProfileArn("access", "us-east-1")).resolves.toContain(":profile/PROFILE");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://q.us-east-1.amazonaws.com",
      expect.objectContaining({
        identity: "openai-node",
        provider: "kiro",
        format: "kiro",
        headers: expect.objectContaining({
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
          Authorization: "Bearer access",
        }),
      }),
    );
  });
});

describe("kimi-coding stable device id circuit", () => {
  it("mints a device id at request time and threads it through poll into tokens", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({
        device_code: "dc",
        user_code: "UC-1",
        verification_uri: "https://www.kimi.com/code/authorize_device",
        interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "kimi-access", refresh_token: "r" }));

    const deviceData = await requestDeviceCode("kimi-coding");
    expect(deviceData._kimiDeviceId).toMatch(/^[0-9a-f-]{36}$/);

    // The route forwards extraData from the frontend; the poll must reuse the
    // SAME X-Msh-Device-Id that requestDeviceCode used, not mint a fresh one.
    const { tokens } = await pollForToken("kimi-coding", "dc", null, { _kimiDeviceId: deviceData._kimiDeviceId });

    expect(tokens.providerSpecificData).toEqual({ deviceId: deviceData._kimiDeviceId });
    const [, pollInit] = proxyAwareFetch.mock.calls[1];
    expect(pollInit.headers["X-Msh-Device-Id"]).toBe(deviceData._kimiDeviceId);
  });
});
