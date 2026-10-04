import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import museProvider from "../../open-sse/providers/registry/muse.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveProfileId, profileHeaders } from "../../open-sse/identity/catalog.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getProvider } from "../../src/lib/oauth/providers.js";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("muse provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("declares the correct Meta Muse registry configuration", () => {
    expect(museProvider.id).toBe("muse");
    expect(museProvider.alias).toBe("muse");
    expect(museProvider.aliases).toContain("meta");
    expect(museProvider.category).toBe("oauth");
    expect(museProvider.hasOAuth).toBe(true);
    expect(museProvider.transport).toMatchObject({
      baseUrl: "https://api.meta.ai/v1/chat/completions",
      format: "openai",
      identity: "muse-code",
    });
    expect(museProvider.oauth).toMatchObject({
      clientId: "1031625952748946",
      deviceCodeUrl: "https://auth.meta.com/oidc/device/authorization/",
      tokenUrl: "https://auth.meta.com/oidc/device/token/",
      mintUrl: "https://api.meta.ai/muse-code/key",
    });
    expect(museProvider.models.map((m) => m.id)).toContain("muse-spark-1.3-contributor");
  });

  it("resolves capabilities for muse-spark models", () => {
    const caps = getCapabilitiesForModel("muse", "muse-spark-1.3-contributor");
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("resolves identity profile and headers for muse", () => {
    const profileId = resolveProfileId(null, { provider: "muse" });
    expect(profileId).toBe("muse-code");
    const headers = profileHeaders("muse-code");
    expect(headers["User-Agent"]).toBe("muse-code/1.0.2");
  });

  it("infers muse provider from model name without prefix", async () => {
    const resolved = await getModelInfoCore("muse-spark-1.3-contributor", {});
    expect(resolved.provider).toBe("muse");
    expect(resolved.model).toBe("muse-spark-1.3-contributor");
  });

  it("requests device code correctly via OAuth handler", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: "dev_123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.meta.com/device",
        verification_uri_complete: "https://auth.meta.com/device?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 5,
      })
    );

    const handler = getProvider("muse");
    const result = await handler.requestDeviceCode(handler.config);

    expect(result.device_code).toBe("dev_123");
    expect(result.user_code).toBe("ABCD-EFGH");
    expect(result.verification_uri_complete).toBe("https://auth.meta.com/device?user_code=ABCD-EFGH");
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://auth.meta.com/oidc/device/authorization/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "muse-code/1.0.2",
        }),
      })
    );
  });

  it("polls token and mints API key on success", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "dca:token_xyz",
          token_type: "Bearer",
          expires_in: 7776000,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          api_key: "muse_api_key_123",
          base_url: "https://api.meta.ai/v1",
          user_email: "test@example.com",
          user_full_name: "Test User",
          subs_tier_name: "Pro",
          subs_tier_id: "tier_pro",
          is_subs_active: true,
        })
      );

    const handler = getProvider("muse");
    const pollRes = await handler.pollToken(handler.config, "dev_123");
    expect(pollRes.ok).toBe(true);
    expect(pollRes.data.access_token).toBe("dca:token_xyz");

    const minted = await handler.postExchange(pollRes.data);
    expect(minted.api_key).toBe("muse_api_key_123");

    const mapped = handler.mapTokens(pollRes.data, minted);
    expect(mapped.accessToken).toBe("muse_api_key_123");
    expect(mapped.apiKey).toBe("muse_api_key_123");
    expect(mapped.email).toBe("test@example.com");
    expect(mapped.displayName).toBe("Test User");
    expect(mapped.providerSpecificData).toMatchObject({
      dcaToken: "dca:token_xyz",
      apiKey: "muse_api_key_123",
      baseUrl: "https://api.meta.ai/v1",
      subsTierName: "Pro",
      isSubsActive: true,
    });
  });
});
