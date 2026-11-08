import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

// proxyAwareFetch captures globalThis.fetch at import time — mock the module
// (like glm-oauth.test.js) so postExchange's user fetch never hits the wire.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import {
  getProvider,
  generateAuthData,
  exchangeTokens,
} from "../../src/lib/oauth/providers";
import { ZED_HOSTED_CONFIG, PROVIDERS } from "../../src/lib/oauth/constants/oauth";
import {
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startZedProxy,
  stopZedProxy,
} from "../../src/lib/oauth/utils/server.js";
import {
  encodeZedPrivateKeyVerifier,
  buildZedUserAuthHeader,
} from "../../open-sse/shared/zedAuth.js";
import { PROVIDER_OAUTH } from "../../open-sse/providers/index.js";

const zed = getProvider("zed");

function makeKeypairVerifier() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { privateKey, verifier: encodeZedPrivateKeyVerifier(privateKey) };
}

function encryptToken(userId, verifier, keypairPrivate) {
  // Encrypt with the PUBLIC key recovered from the same keypair the verifier
  // encodes (browser side only ever sees zed.dev's redirect, which encrypts to
  // the public key registered in native_app_signin).
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return crypto.publicEncrypt(
    publicKey,
    Buffer.from(`tok-${userId}`)
  ).toString("base64");
}

function makeCallbackUrl(userId, encrypted) {
  return `http://127.0.0.1:58443/?user_id=${userId}&access_token=${encodeURIComponent(encrypted)}`;
}

/** RSA-OAEP(SHA-256) encrypt with the verifier's keypair's public half. */
function oaepEncryptWithPrivate(privateKeyPem, plaintext) {
  // Re-derive a public key object from the private key.
  const priv = crypto.createPrivateKey(privateKeyPem);
  const derivedPublic = crypto.createPublicKey(priv);
  return crypto.publicEncrypt(
    { key: derivedPublic, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(plaintext)
  ).toString("base64");
}

beforeEach(() => {
  vi.mocked(proxyAwareFetch).mockReset();
  stopZedProxy();
  clearZedSession();
});

afterEach(() => {
  stopZedProxy();
  clearZedSession();
});

describe("zed constants + registry wiring", () => {
  it("exposes ZED_HOSTED_CONFIG and PROVIDERS.ZED", () => {
    expect(PROVIDERS.ZED).toBe("zed");
    expect(ZED_HOSTED_CONFIG.defaultNativeAppPort).toBe(58443);
    expect(ZED_HOSTED_CONFIG.oauthTimeoutMs).toBe(600_000);
  });

  it("has an OAuth registry entry (oauth-category provider)", () => {
    expect(PROVIDER_OAUTH.zed).toBeDefined();
  });
});

describe("zed provider entry (RSA native-app flow)", () => {
  it("prepareConfig builds a native_app_signin URL + private key verifier", async () => {
    const cfg = await zed.prepareConfig(zed.config, { nativeAppPort: 58443 });
    expect(cfg.authUrl).toContain("https://zed.dev/native_app_signin");
    expect(cfg.authUrl).toContain("native_app_port=58443");
    expect(cfg.privateKeyVerifier).toBeTruthy();
    expect(cfg.systemId).toBeTruthy();
    // authUrl embeds the SPKI public key so zed.dev can encrypt the token.
    expect(cfg.authUrl).toMatch(/public_key=[A-Za-z0-9%+-]+/);
  });

  it("buildAuthUrl returns the prepared authUrl", async () => {
    const cfg = await zed.prepareConfig(zed.config, { nativeAppPort: 12345 });
    expect(zed.buildAuthUrl(cfg, "http://127.0.0.1:12345/", "state-1")).toBe(cfg.authUrl);
    expect(cfg.authUrl).toContain("native_app_port=12345");
  });

  it("exchangeToken decrypts the callback payload with the keypair verifier", async () => {
    const { privateKey, verifier } = makeKeypairVerifier();
    const encrypted = oaepEncryptWithPrivate(privateKey, "tok-user-42");
    const callbackUrl = makeCallbackUrl("user-42", encrypted);
    const tokens = await zed.exchangeToken(
      { systemId: "sys-1" },
      callbackUrl,
      null,
      verifier,
      "state-1"
    );
    expect(tokens.accessToken).toBe("tok-user-42");
    expect(tokens.userId).toBe("user-42");
    expect(tokens.systemId).toBe("sys-1");
  });

  it("mapTokens persists userId/systemId/organizationId", () => {
    const mapped = zed.mapTokens(
      { accessToken: "a", userId: "u1", systemId: "s1" },
      { email: "z@zed.dev", name: "Zed User", organizationId: "org-9" }
    );
    expect(mapped.accessToken).toBe("a");
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.email).toBe("z@zed.dev");
    expect(mapped.displayName).toBe("Zed User");
    expect(mapped.providerSpecificData).toMatchObject({
      userId: "u1",
      systemId: "s1",
      organizationId: "org-9",
    });
  });

  it("postExchange resolves the organization (best-effort user fetch)", async () => {
    const userBody = { email: "z@zed.dev", default_organization_id: "org-77" };
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(userBody),
      json: async () => userBody,
    });
    const out = await zed.postExchange({ accessToken: "a", userId: "u1", systemId: "s1" });
    expect(out.email).toBe("z@zed.dev");
    expect(out.organizationId).toBe("org-77");
  });

  it("postExchange survives a failing user fetch", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValueOnce(new Error("offline"));
    const out = await zed.postExchange({ accessToken: "a", userId: "u1", systemId: "s1" });
    expect(out.userInfo).toBeNull();
    expect(out.organizationId).toBe("");
  });
});

describe("generateAuthData for zed", () => {
  it("returns the native_app_signin URL and key-carrying codeVerifier", async () => {
    const data = await generateAuthData("zed", "http://127.0.0.1:58443/");
    expect(data.authUrl).toContain("https://zed.dev/native_app_signin");
    expect(data.authUrl).toContain("native_app_port=58443");
    expect(data.state).toBeTruthy();
    // codeVerifier is the encoded RSA private key, not a PKCE string.
    expect(data.codeVerifier).not.toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(() => Buffer.from(data.codeVerifier, "base64")).not.toThrow();
    expect(data.redirectUri).toBe("http://127.0.0.1:58443/");
  });

  it("uses the config default port when the redirect has none", async () => {
    const data = await generateAuthData("zed", "http://127.0.0.1/");
    expect(data.authUrl).toContain(`native_app_port=${ZED_HOSTED_CONFIG.defaultNativeAppPort}`);
  });
});

describe("exchangeTokens end-to-end (decrypt + map)", () => {
  it("decrypts the callback and maps a connection payload", async () => {
    const { privateKey, verifier } = makeKeypairVerifier();
    const encrypted = oaepEncryptWithPrivate(privateKey, "tok-e2e");
    const callbackUrl = makeCallbackUrl("u-e2e", encrypted);
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ email: "e2e@zed.dev", default_organization_id: "org-e2e" }),
      json: async () => ({ email: "e2e@zed.dev", default_organization_id: "org-e2e" }),
    });
    const tokenData = await exchangeTokens("zed", callbackUrl, null, verifier, "st");
    expect(tokenData.accessToken).toBe("tok-e2e");
    expect(tokenData.providerSpecificData.userId).toBe("u-e2e");
    expect(tokenData.providerSpecificData.organizationId).toBe("org-e2e");
    expect(tokenData.email).toBe("e2e@zed.dev");
  });
});

describe("zed proxy session registry", () => {
  it("registers, reads, and clears a session", () => {
    expect(registerZedSession({ state: "s1", codeVerifier: "v1" })).toBe(true);
    expect(getZedSessionStatus("s1")).toMatchObject({ state: "s1", status: "pending" });
    expect(getZedSessionStatus("other")).toBeNull();
    clearZedSession("s1");
    expect(getZedSessionStatus("s1")).toBeNull();
  });

  it("rejects registration without state or verifier", () => {
    expect(registerZedSession({ state: "s1" })).toBe(false);
    expect(registerZedSession({ codeVerifier: "v" })).toBe(false);
  });

  it("latest registration wins (singleton session)", () => {
    registerZedSession({ state: "s1", codeVerifier: "v1" });
    registerZedSession({ state: "s2", codeVerifier: "v2" });
    expect(getZedSessionStatus("s1")).toBeNull();
    expect(getZedSessionStatus("s2")).toMatchObject({ state: "s2" });
  });
});

describe("zed local callback proxy", () => {
  it("starts on a random port and reports its callback URL", async () => {
    const result = await startZedProxy(0);
    expect(result.success).toBe(true);
    expect(result.port).toBeGreaterThan(0);
    expect(result.callbackUrl).toBe(`http://127.0.0.1:${result.port}/`);
  });

  it("rejects cross-origin callbacks (CSRF defense-in-depth)", async () => {
    const result = await startZedProxy(0);
    registerZedSession({ state: "s-xss", codeVerifier: "v" });
    const res = await fetch(`http://127.0.0.1:${result.port}/?user_id=u&access_token=x`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("404s non-callback paths", async () => {
    const result = await startZedProxy(0);
    const res = await fetch(`http://127.0.0.1:${result.port}/nope`);
    expect(res.status).toBe(404);
  });
});
