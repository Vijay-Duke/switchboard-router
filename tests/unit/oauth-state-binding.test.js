import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { exchangeTokens: exchangeTokensMock, createProviderConnection: createConnectionMock } = vi.hoisted(() => ({
  exchangeTokens: vi.fn(),
  createProviderConnection: vi.fn(),
}));

vi.mock("../../src/lib/oauth/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exchangeTokens: (...args) => exchangeTokensMock(...args) };
});
vi.mock("@/lib/oauth/providers", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exchangeTokens: (...args) => exchangeTokensMock(...args) };
});
vi.mock("../../src/models", () => ({
  createProviderConnection: (...args) => createConnectionMock(...args),
}));
vi.mock("@/models", () => ({
  createProviderConnection: (...args) => createConnectionMock(...args),
}));

import {
  registerOAuthState,
  getOAuthState,
  clearOAuthState,
} from "../../src/lib/oauth/utils/server.js";
import { generateAuthData } from "../../src/lib/oauth/providers.js";
import { POST } from "../../src/app/api/oauth/[provider]/[action]/route.js";

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

function exchangeRequest(provider, body) {
  return POST(
    new Request(`http://localhost/api/oauth/${provider}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider, action: "exchange" }) },
  );
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  exchangeTokensMock.mockReset();
  createConnectionMock.mockReset();
  exchangeTokensMock.mockResolvedValue({ accessToken: "exchanged", expiresIn: 3600 });
  createConnectionMock.mockImplementation(async (data) => ({
    id: "conn-1",
    provider: data.provider,
    email: data.email || null,
    displayName: data.displayName || null,
  }));
});

describe("oauth state store", () => {
  it("round-trips a registered state for the same provider", () => {
    expect(registerOAuthState({
      state: "state-1",
      provider: "claude",
      codeVerifier: "verifier-1",
      redirectUri: "http://localhost/callback",
    })).toBe(true);
    expect(getOAuthState("state-1", "claude")).toMatchObject({
      provider: "claude",
      codeVerifier: "verifier-1",
    });
  });

  it("rejects unknown states and cross-provider reuse", () => {
    registerOAuthState({ state: "state-2", provider: "claude", codeVerifier: "v", redirectUri: "r" });
    expect(getOAuthState("missing", "claude")).toBeNull();
    expect(getOAuthState("state-2", "codex")).toBeNull();
  });

  it("expires entries after the TTL", () => {
    registerOAuthState({ state: "state-3", provider: "claude", codeVerifier: "v", redirectUri: "r" });
    const entry = getOAuthState("state-3", "claude");
    expect(entry).not.toBeNull();
    expect(getOAuthState("state-3", "claude", Date.now() + 11 * 60 * 1000)).toBeNull();
    expect(getOAuthState("state-3", "claude")).toBeNull();
  });

  it("clearOAuthState forgets a state", () => {
    registerOAuthState({ state: "state-4", provider: "xai", codeVerifier: "v", redirectUri: "r" });
    clearOAuthState("state-4");
    expect(getOAuthState("state-4", "xai")).toBeNull();
  });

  it("generateAuthData registers the issued state", async () => {
    const authData = await generateAuthData("codex", "http://localhost:1455/auth/callback");
    expect(authData.state).toBeTruthy();
    expect(getOAuthState(authData.state, "codex")).toMatchObject({
      codeVerifier: authData.codeVerifier,
      redirectUri: "http://localhost:1455/auth/callback",
    });
  });
});

describe("oauth exchange state binding", () => {
  it("rejects an unknown state with 400", async () => {
    const res = await exchangeRequest("claude", {
      code: "auth-code",
      redirectUri: "http://localhost/callback",
      codeVerifier: "verifier",
      state: "never-issued",
    });
    expect(res.status).toBe(400);
    expect(exchangeTokensMock).not.toHaveBeenCalled();
  });

  it("rejects a missing state for PKCE providers with 400", async () => {
    const res = await exchangeRequest("claude", {
      code: "auth-code",
      redirectUri: "http://localhost/callback",
      codeVerifier: "verifier",
    });
    expect(res.status).toBe(400);
    expect(exchangeTokensMock).not.toHaveBeenCalled();
  });

  it("uses the stored verifier/redirect and consumes the state on success", async () => {
    const authData = await generateAuthData("codex", "http://localhost:1455/auth/callback");

    const res = await exchangeRequest("codex", {
      code: "auth-code",
      redirectUri: "http://attacker.example/callback",
      codeVerifier: "attacker-verifier",
      state: authData.state,
    });

    expect(res.status).toBe(200);
    expect(exchangeTokensMock).toHaveBeenCalledWith(
      "codex",
      "auth-code",
      "http://localhost:1455/auth/callback",
      authData.codeVerifier,
      authData.state,
      undefined,
    );

    // Replaying the same state after success is rejected.
    const replay = await exchangeRequest("codex", {
      code: "auth-code",
      redirectUri: "http://localhost:1455/auth/callback",
      codeVerifier: authData.codeVerifier,
      state: authData.state,
    });
    expect(replay.status).toBe(400);
    expect(exchangeTokensMock).toHaveBeenCalledTimes(1);
  });
});

describe("oauth exchange providers that never round-trip state", () => {
  it("cline exchanges without any state (upstream never echoes one)", async () => {
    const res = await exchangeRequest("cline", {
      code: "cline-code",
      redirectUri: "http://localhost/callback",
    });
    expect(res.status).toBe(200);
    expect(exchangeTokensMock).toHaveBeenCalledWith(
      "cline", "cline-code", "http://localhost/callback", undefined, undefined, undefined,
    );
  });

  it("kimchi JWT browser tokens go through the kimchi exchange, not the raw-token path", async () => {
    const token = jwt({ sub: "kimchi-user", iss: "https://app.kimchi.dev" });
    const res = await exchangeRequest("kimchi", {
      code: token,
      redirectUri: "http://localhost/callback",
      state: "whatever-kimchi-echoed",
    });
    expect(res.status).toBe(200);
    expect(exchangeTokensMock).toHaveBeenCalledWith(
      "kimchi", token, "http://localhost/callback", undefined, "whatever-kimchi-echoed", undefined,
    );
    expect(createConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ authType: "oauth" }));
  });
});

describe("oauth exchange raw-JWT path", () => {
  const codexPayload = {
    iss: "https://auth.openai.com",
    email: "user@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "plus" },
  };

  it("rejects raw tokens for providers without acceptsRawAccessToken", async () => {
    const res = await exchangeRequest("xai", { code: jwt(codexPayload) });
    expect(res.status).toBe(400);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects codex tokens with a foreign issuer", async () => {
    const res = await exchangeRequest("codex", {
      code: jwt({ ...codexPayload, iss: "https://evil.example" }),
    });
    expect(res.status).toBe(400);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("rejects JWTs without ChatGPT identity claims", async () => {
    const res = await exchangeRequest("codex", {
      code: jwt({ email: "someone@example.com" }),
    });
    expect(res.status).toBe(400);
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("returns a clear 400 for an undecodable token", async () => {
    const res = await exchangeRequest("codex", { code: "eyJ.not-base64-json.sig" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/decoded/i) });
    expect(createConnectionMock).not.toHaveBeenCalled();
  });

  it("accepts a ChatGPT website token with top-level claims and the legacy auth0 issuer", async () => {
    const token = jwt({
      iss: "https://auth0.openai.com/",
      aud: ["https://api.openai.com/v1"],
      account_id: "acc-web",
      plan_type: "plus",
      email: "web@example.com",
    });
    const res = await exchangeRequest("codex", { code: token });
    expect(res.status).toBe(200);
    expect(createConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      providerSpecificData: expect.objectContaining({ chatgptAccountId: "acc-web", chatgptPlanType: "plus" }),
    }));
  });

  it("accepts a recognized ChatGPT token for codex", async () => {
    const token = jwt(codexPayload);
    const res = await exchangeRequest("codex", { code: token });
    expect(res.status).toBe(200);
    expect(createConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      authType: "access_token",
      accessToken: token,
    }));
  });
});
