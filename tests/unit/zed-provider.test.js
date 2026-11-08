import { afterAll } from "vitest";

// Zed provider base wiring — registry, executor mapping, zedAuth primitives,
// and the token-refresh stub (no OAuth grant exists for the RSA keypair flow).
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import registryZed from "../../open-sse/providers/registry/zed.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { refreshZedToken } from "../../open-sse/services/tokenRefresh.js";
import {
  ZED_HEADERS,
  ZED_WEB_BASE_URL,
  ZED_CLOUD_BASE_URL,
  createZedNativeAuthData,
  encodeZedPrivateKeyVerifier,
  decodeZedPrivateKeyVerifier,
  parseZedCallbackPayload,
  decryptZedAccessToken,
  buildZedUserAuthHeader,
  clearZedCaches,
} from "../../open-sse/shared/zedAuth.js";

describe("zed registry entry", () => {
  it("declares the hosted LLM transport with an explicit identity", () => {
    expect(registryZed.id).toBe("zed");
    expect(registryZed.alias).toBe("zd");
    expect(registryZed.transport.baseUrl).toBe("https://cloud.zed.dev/completions");
    expect(registryZed.transport.format).toBe("openai");
    expect(registryZed.transport.forceStream).toBe(true);
    // Every outbound transport declares its identity profile (invariant).
    expect(registryZed.transport.identity).toBe("openai-node");
    expect(registryZed.passthroughModels).toBe(true);
    expect(registryZed.models).toEqual([]);
    expect(registryZed.oauth.rsaKeyExchange).toBe(true);
    expect(registryZed.hasOAuth).toBe(true);
  });
});

describe("zed executor wiring", () => {
  it("maps zed + zd alias to the ZedExecutor", async () => {
    const ex = getExecutor("zed");
    expect(ex.provider).toBe("zed");
    expect(getExecutor("zd").provider).toBe("zed");
    expect(typeof ex.execute).toBe("function");
    expect(ex.needsRefresh()).toBe(false);
    expect(await ex.refreshCredentials()).toBe(null);
  });
});

describe("zedAuth keypair primitives", () => {
  it("round-trips the private key through the codeVerifier slot", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 58443, systemId: "sys-1" });
    expect(auth.nativeAppPort).toBe(58443);
    expect(auth.systemId).toBe("sys-1");
    expect(auth.authUrl.startsWith(`${ZED_WEB_BASE_URL}/native_app_signin?`)).toBe(true);
    const url = new URL(auth.authUrl);
    expect(url.searchParams.get("native_app_port")).toBe("58443");
    expect(url.searchParams.get("native_app_public_key")).toBe(auth.publicKey);
    expect(url.searchParams.get("system_id")).toBe("sys-1");
    const pem = decodeZedPrivateKeyVerifier(auth.privateKeyVerifier);
    expect(pem).toContain("PRIVATE KEY");
    expect(encodeZedPrivateKeyVerifier(pem)).toBe(auth.privateKeyVerifier);
  });

  it("uses a fresh systemId when none is provided", () => {
    const auth = createZedNativeAuthData({});
    expect(auth.systemId).toMatch(/[0-9a-f-]{36}/);
  });

  it("rejects a verifier that is not a Zed private key", () => {
    expect(() => decodeZedPrivateKeyVerifier("not-a-zed-verifier")).toThrow(/Zed private key/);
  });
});

describe("parseZedCallbackPayload", () => {
  it("parses a full loopback callback URL", () => {
    const { userId, encryptedAccessToken } = parseZedCallbackPayload(
      "http://127.0.0.1:58443/?user_id=u-1&access_token=enc-token",
    );
    expect(userId).toBe("u-1");
    expect(encryptedAccessToken).toBe("enc-token");
  });

  it("parses a bare query string and a JSON body", () => {
    expect(parseZedCallbackPayload("?user_id=u-2&access_token=t2")).toEqual({
      userId: "u-2",
      encryptedAccessToken: "t2",
    });
    expect(parseZedCallbackPayload(JSON.stringify({ userId: "u-3", accessToken: "t3" }))).toEqual({
      userId: "u-3",
      encryptedAccessToken: "t3",
    });
  });

  it("throws on missing pieces", () => {
    expect(() => parseZedCallbackPayload("")).toThrow(/Missing Zed callback/);
    expect(() => parseZedCallbackPayload("http://127.0.0.1:1/?user_id=u")).toThrow(
      /user_id and access_token/,
    );
  });
});

describe("decryptZedAccessToken", () => {
  it("decrypts an OAEP-SHA256 encrypted token with the paired private key", () => {
    const auth = createZedNativeAuthData({});
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(auth.publicKey, "base64url"),
      format: "der",
      type: "pkcs1",
    });
    const encrypted = crypto
      .publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from("secret-zed-token", "utf8"),
      )
      .toString("base64url");
    expect(decryptZedAccessToken(encrypted, auth.privateKeyVerifier)).toBe("secret-zed-token");
  });

  it("throws when the verifier is not a Zed private key", () => {
    expect(() => decryptZedAccessToken("AAAA", "not-a-zed-verifier")).toThrow(
      /Zed private key/,
    );
  });
});

describe("buildZedUserAuthHeader", () => {
  it("combines userId + accessToken from providerSpecificData", () => {
    expect(
      buildZedUserAuthHeader({
        accessToken: "tok",
        providerSpecificData: { userId: "u-9" },
      }),
    ).toBe("u-9 tok");
  });

  it("falls back to top-level userId", () => {
    expect(buildZedUserAuthHeader({ userId: "u-8", apiKey: "key" })).toBe("u-8 key");
  });

  it("throws when the credential is incomplete", () => {
    expect(() => buildZedUserAuthHeader({ accessToken: "tok" })).toThrow(/missing userId/);
  });
});

describe("zed token refresh", () => {
  it("reports nothing to refresh (long-lived RSA-decrypted token)", () => {
    expect(refreshZedToken()).toBe(null);
  });
});

describe("ZED_HEADERS contract", () => {
  it("keeps the zed.dev wire header names", () => {
    expect(ZED_HEADERS.expiredToken).toBe("x-zed-expired-token");
    expect(ZED_HEADERS.outdatedToken).toBe("x-zed-outdated-token");
    expect(ZED_HEADERS.systemId).toBe("x-zed-system-id");
    expect(ZED_CLOUD_BASE_URL).toBe("https://cloud.zed.dev");
    expect(ZED_WEB_BASE_URL).toBe("https://zed.dev");
  });
});

// Keep module-level caches clean between test files in the same worker.
afterAll(() => {
  clearZedCaches();
});
