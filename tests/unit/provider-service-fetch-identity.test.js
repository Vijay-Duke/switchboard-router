import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue("private-key"),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return "signed-jwt"; }
  },
}));

import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveClinepassModels } from "../../open-sse/services/clinepassModels.js";
import { clearKiroModelCache, resolveKiroModels } from "../../open-sse/services/kiroModels.js";
import {
  cleanupNow,
  getProjectIdForConnection,
  invalidateProjectId,
} from "../../open-sse/services/projectId.js";
import {
  clearProviderModelCache,
  resolveProviderModels,
} from "../../open-sse/services/providerModels.js";
import { refreshVertexToken } from "../../open-sse/services/tokenRefresh.js";
import { refreshGoogleToken } from "../../open-sse/services/tokenRefresh/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearKiroModelCache();
  clearProviderModelCache();
  cleanupNow();
});

describe("provider service fetch identities", () => {
  it("uses the ClinePass inference profile and caller proxy for model discovery", async () => {
    const proxyOptions = { enabled: true, url: "http://proxy.example:8080" };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse([
      { id: "cline-pass/glm-5.2", name: "GLM-5.2" },
    ]));

    await resolveClinepassModels({ apiKey: "cline-key" }, { proxyOptions });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        method: "GET",
        identity: PROVIDERS.clinepass.identity,
        provider: "clinepass",
        format: PROVIDERS.clinepass.format,
      }),
      proxyOptions,
    );
  });

  it("uses the Kiro registry transport profile for model discovery", async () => {
    const proxyOptions = { vercelRelayUrl: "https://relay.example/fetch" };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      models: [{ modelId: "claude-sonnet-5", modelName: "Claude Sonnet 5" }],
    }));

    await resolveKiroModels({
      accessToken: "kiro-token",
      providerSpecificData: {},
    }, { proxyOptions });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("amazonaws.com/ListAvailableModels"),
      expect.objectContaining({
        method: "GET",
        identity: PROVIDERS.kiro.identity,
        provider: "kiro",
        format: PROVIDERS.kiro.format,
      }),
      proxyOptions,
    );
  });

  it("keeps the Kiro profile and proxy on the 401 refresh side channel", async () => {
    const proxyOptions = { vercelRelayUrl: "https://relay.example/fetch" };
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "fresh-token", expiresIn: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));

    await resolveKiroModels({
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    }, { proxyOptions, forceRefresh: true });

    expect(mocks.proxyAwareFetch).toHaveBeenNthCalledWith(
      2,
      PROVIDERS.kiro.tokenUrl,
      expect.objectContaining({
        identity: PROVIDERS.kiro.identity,
        provider: "kiro",
        format: PROVIDERS.kiro.format,
      }),
      proxyOptions,
    );
  });

  it("uses each catalog entry transport profile and caller proxy for generic model discovery", async () => {
    const proxyOptions = { strictProxy: true, url: "http://proxy.example:8080" };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "model-a" }] }));

    await resolveProviderModels({
      id: "commandcode-identity-test",
      provider: "commandcode",
      apiKey: "user_test",
    }, { proxyOptions });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.commandcode.ai/provider/v1/models",
      expect.objectContaining({
        identity: PROVIDERS.commandcode.identity,
        provider: "commandcode",
        format: PROVIDERS.commandcode.format,
      }),
      proxyOptions,
    );
  });

  it.each(["antigravity", "gemini-cli"])(
    "uses the %s Cloud Code profile for project lookup",
    async (provider) => {
      const proxyOptions = { enabled: true, url: "http://proxy.example:8080" };
      const connectionId = `project-id-${provider}`;
      mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
        cloudaicompanionProject: `${provider}-project`,
      }));

      const result = await getProjectIdForConnection(
        connectionId,
        "google-token",
        provider,
        proxyOptions,
      );

      expect(result).toBe(`${provider}-project`);
      expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
        expect.stringContaining("loadCodeAssist"),
        expect.objectContaining({
          method: "POST",
          identity: PROVIDERS[provider].identity,
          provider,
          format: PROVIDERS[provider].format,
        }),
        proxyOptions,
      );
      invalidateProjectId(connectionId);
    },
  );

  it("uses the requested Vertex provider profile when minting a service-account token", async () => {
    const proxyOptions = { enabled: true, url: "http://proxy.example:8080" };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      access_token: "vertex-access-token",
      expires_in: 3600,
    }));

    await refreshVertexToken({
      client_email: "service-account@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      project_id: "vertex-project",
    }, null, "vertex", proxyOptions);

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("oauth2.googleapis.com/token"),
      expect.objectContaining({
        method: "POST",
        identity: PROVIDERS.vertex.identity,
        provider: "vertex",
        format: PROVIDERS.vertex.format,
      }),
      proxyOptions,
    );
  });

  it("accepts an explicit provider profile for generic Google refresh", async () => {
    const proxyOptions = { enabled: true, url: "http://proxy.example:8080" };
    mocks.proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      access_token: "vertex-adc-token",
      expires_in: 3600,
    }));

    await refreshGoogleToken(
      "refresh-token",
      "custom-client-id",
      "custom-client-secret",
      null,
      "vertex",
      proxyOptions,
    );

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("oauth2.googleapis.com/token"),
      expect.objectContaining({
        identity: PROVIDERS.vertex.identity,
        provider: "vertex",
        format: PROVIDERS.vertex.format,
      }),
      proxyOptions,
    );
  });
});
