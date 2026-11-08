// Acceptance suite for the Zed native-app auth fix.
// Covers criteria:
//   1. Zed proxy starts
//   2. Stray callback (no params) MUST NOT kill session / stop proxy
//   3. Real callback (user_id + access_token) MUST complete session + save connection
//   4. RSA decrypt works (round-trip) + garbage PKCS#1 v1.5 rejection
//   5. systemId identical authorize → exchange → stored connection
//   6. register-session failure is distinguishable (backend contract)
//   8. (backend) reopen/re-register creates a fresh session
//  L.   decrypt failure errors the session but keeps the server alive
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const { proxyAwareFetch } = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

// Persisted connections are asserted at the createProviderConnection boundary
// (no real DB): the proxy dynamic-imports @/models, which resolves to this mock.
const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }));
vi.mock("../../src/models", () => ({
  createProviderConnection: (...args) => createConnectionMock(...args),
}));
vi.mock("@/models", () => ({
  createProviderConnection: (...args) => createConnectionMock(...args),
}));

import { createZedNativeAuthData, parseZedCallbackPayload, decryptZedAccessToken } from "open-sse/shared/zedAuth.js";
import {
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
} from "@/lib/oauth/utils/server.js";
import { generateAuthData, exchangeTokens } from "@/lib/oauth/providers";
import { POST as oauthPOST } from "@/app/api/oauth/[provider]/[action]/route.js";

const realFetch = globalThis.fetch;

// Never hit the real network in tests: cloud.zed.dev calls are best-effort
// (postExchange try/catch) — fail them fast and loud instead.
beforeEach(() => {
  proxyAwareFetch.mockReset();
  proxyAwareFetch.mockImplementation(async (url) => {
    if (String(url).includes("cloud.zed.dev")) {
      return new Response("test-stubbed", { status: 500 });
    }
    return realFetch(url);
  });
  createConnectionMock.mockReset();
  createConnectionMock.mockImplementation(async (data) => ({
    id: "conn-zed-1",
    provider: data.provider,
    email: data.email || null,
  }));
});
afterEach(async () => {
  stopZedProxy();
  clearZedSession();
  vi.restoreAllMocks();
});

async function startTestProxy() {
  const started = await startZedProxy(0); // random loopback port — parallel-safe
  expect(started.success).toBe(true);
  return started;
}

/** Simulate zed.dev: RSA-encrypt a plaintext token with the flow's public key. */
function encryptForCallback(publicKeyB64Url, plaintext) {
  const der = Buffer.from(String(publicKeyB64Url), "base64url");
  const key = crypto.createPublicKey({ key: der, format: "der", type: "pkcs1" });
  return crypto
    .publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(plaintext, "utf8"),
    )
    .toString("base64url");
}

/** PKCS#1 v1.5 ciphertext whose plaintext is NOT valid UTF-8 (garbage). */
function v15GarbageFor(publicKeyB64Url) {
  const der = Buffer.from(String(publicKeyB64Url), "base64url");
  const key = crypto.createPublicKey({ key: der, format: "der", type: "pkcs1" });
  return crypto
    .publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      // Bytes that decode to replacement characters — exactly the wrong-key
      // "successful" unpad the hardening rejects.
      Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81, 0xc0]),
    )
    .toString("base64url");
}

describe("criterion 1 — Zed proxy starts", () => {
  it("binds 127.0.0.1 and reports a usable callback URL", async () => {
    const started = await startTestProxy();
    expect(started.port).toBeGreaterThan(0);
    expect(started.callbackUrl).toBe(`http://127.0.0.1:${started.port}/`);
  });
});

describe("criterion 4 — RSA decrypt works", () => {
  it("round-trips OAEP-SHA256 through the verifier slot", async () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const encrypted = encryptForCallback(auth.publicKey, "plaintext-token-abc");
    expect(decryptZedAccessToken(encrypted, auth.privateKeyVerifier)).toBe(
      "plaintext-token-abc",
    );
  });

  it("rejects a missing verifier instead of silently failing", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const encrypted = encryptForCallback(auth.publicKey, "x");
    expect(() => decryptZedAccessToken(encrypted, null)).toThrow(
      /private key verifier/i,
    );
  });

  it("rejects garbage PKCS#1 v1.5 output instead of storing it", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    // v1.5 has no integrity check: a decrypt that "succeeds" with non-UTF-8
    // bytes (what a wrong-key ciphertext yields) must fail loudly.
    const garbage = v15GarbageFor(auth.publicKey);
    expect(() => decryptZedAccessToken(garbage, auth.privateKeyVerifier)).toThrow(
      /Failed to decrypt Zed access token/,
    );
  });

  it("parser keeps strict validation (no weakened acceptance)", () => {
    expect(() => parseZedCallbackPayload("")).toThrow();
    expect(() => parseZedCallbackPayload("http://127.0.0.1:1/")).toThrow(
      /user_id and access_token/,
    );
    expect(() =>
      parseZedCallbackPayload("http://127.0.0.1:1/?user_id=only-user"),
    ).toThrow(/user_id and access_token/);
  });

  it("parser accepts pathname+query and bare query forms", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const encrypted = encryptForCallback(auth.publicKey, "tok-parse");
    const fromPath = parseZedCallbackPayload(
      `/callback?user_id=u1&access_token=${encodeURIComponent(encrypted)}`,
    );
    expect(fromPath).toEqual({ userId: "u1", encryptedAccessToken: encrypted });
    const bare = parseZedCallbackPayload(
      `user_id=u2&access_token=${encodeURIComponent(encrypted)}`,
    );
    expect(bare.userId).toBe("u2");
  });
});

describe("criterion 2 — stray callback MUST NOT kill session", () => {
  it("bare GET / leaves session pending and proxy listening", async () => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    expect(
      registerZedSession({ state: "stray-state-1", codeVerifier: auth.privateKeyVerifier }),
    ).toBe(true);

    const res = await realFetch(`http://127.0.0.1:${started.port}/`);
    expect(res.status).toBe(200);

    // Session must still be pending (not poisoned to error)…
    const session = getZedSessionStatus("stray-state-1");
    expect(session).not.toBeNull();
    expect(session.status).toBe("pending");

    // …and the SAME server must still own the port (no silent restart).
    const again = await startZedProxy(0);
    expect(again.port).toBe(started.port);

    clearZedSession("stray-state-1");
  });

  it("GET /callback with unrelated params leaves session pending", async () => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    registerZedSession({ state: "stray-state-2", codeVerifier: auth.privateKeyVerifier });

    const res = await realFetch(`http://127.0.0.1:${started.port}/callback?foo=bar`);
    expect(res.status).toBe(200);

    const session = getZedSessionStatus("stray-state-2");
    expect(session).not.toBeNull();
    expect(session.status).toBe("pending");
    clearZedSession("stray-state-2");
  });
});

describe("criterion 3 — real callback completes session + saves connection", () => {
  it("user_id + access_token → done, decrypted token persisted", async () => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const state = `real-state-${Date.now()}`;
    registerZedSession({ state, codeVerifier: auth.privateKeyVerifier, systemId: auth.systemId });

    const encrypted = encryptForCallback(auth.publicKey, "decrypted-token-xyz");
    const cb = new URL(`http://127.0.0.1:${started.port}/`);
    cb.searchParams.set("user_id", "user-123");
    cb.searchParams.set("access_token", encrypted);
    const res = await realFetch(cb.toString());
    expect(res.status).toBe(200);

    const session = getZedSessionStatus(state);
    expect(session).not.toBeNull();
    expect(session.status).toBe("done");
    expect(session.connectionId).toBe("conn-zed-1");

    // The persisted connection carries the decrypted token + identity fields.
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    const saved = createConnectionMock.mock.calls[0][0];
    expect(saved.provider).toBe("zed");
    expect(saved.accessToken).toBe("decrypted-token-xyz");
    expect(saved.providerSpecificData?.userId).toBe("user-123");
    expect(saved.providerSpecificData?.systemId).toBe(auth.systemId);

    // Proxy stopped itself after the terminal outcome (no orphan listener).
    const again = await startZedProxy(0);
    expect(again.port).not.toBe(started.port);
    stopZedProxy();
  });
});

describe("criterion 5 — systemId stable authorize → exchange → stored", () => {
  it("generateAuthData exposes the systemId sent to zed.dev", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:59999/", {
      nativeAppPort: 59999,
    });
    const url = new URL(auth.authUrl);
    expect(url.searchParams.get("native_app_port")).toBe("59999");
    // The system_id embedded in the sign-in URL must be observable downstream.
    expect(auth.systemId).toBe(url.searchParams.get("system_id"));
    expect(auth.systemId).toBeTruthy();
  });

  it("exchange preserves the registered systemId (no regeneration)", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:59998/", {
      nativeAppPort: 59998,
    });
    // Public key always rides in the authorize URL (mirrors the real flow).
    const pubFromUrl = new URL(auth.authUrl).searchParams.get("native_app_public_key");
    expect(pubFromUrl).toBeTruthy();
    const enc2 = encryptForCallback(pubFromUrl, "tok2");
    const tokens = await exchangeTokens(
      "zed",
      `/?user_id=u1&access_token=${encodeURIComponent(enc2)}`,
      null,
      auth.codeVerifier,
      auth.state,
      { systemId: auth.systemId },
    );
    expect(tokens.providerSpecificData.systemId).toBe(auth.systemId);
  });

  it("exchange without meta falls back to the prepared config's systemId", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:59997/", {
      nativeAppPort: 59997,
    });
    const pubFromUrl = new URL(auth.authUrl).searchParams.get("native_app_public_key");
    const enc = encryptForCallback(pubFromUrl, "tok3");
    const tokens = await exchangeTokens(
      "zed",
      `/?user_id=u3&access_token=${encodeURIComponent(enc)}`,
      null,
      auth.codeVerifier,
      auth.state,
      undefined,
    );
    // Without the threaded meta the id is freshly prepared (documented
    // fallback) — the proxy always threads meta, so this only proves shape.
    expect(typeof tokens.providerSpecificData.systemId).toBe("string");
    expect(tokens.providerSpecificData.systemId).toBeTruthy();
  });
});

describe("criterion 6 — register-session failure is distinguishable", () => {
  it("route reports { success: false } when the verifier is missing", async () => {
    const req = new Request("http://localhost/api/oauth/zed/register-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "no-verifier-state" }),
    });
    const res = await oauthPOST(req, {
      params: Promise.resolve({ provider: "zed", action: "register-session" }),
    });
    const data = await res.json();
    // Backend contract: failure must be explicit (modal is required to check it).
    expect(data.success).toBe(false);
  });
});

describe("criterion 8 (backend) — re-register creates a fresh session", () => {
  it("a new register supersedes the old state cleanly", async () => {
    const a = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const b = createZedNativeAuthData({}, { nativeAppPort: 1 });
    registerZedSession({ state: "old-state", codeVerifier: a.privateKeyVerifier });
    registerZedSession({ state: "new-state", codeVerifier: b.privateKeyVerifier });

    expect(getZedSessionStatus("old-state")).toBeNull();
    const fresh = getZedSessionStatus("new-state");
    expect(fresh).not.toBeNull();
    expect(fresh.status).toBe("pending");
    expect(fresh.codeVerifier).toBe(b.privateKeyVerifier);
    clearZedSession("new-state");
  });
});

describe("criterion L — decrypt failure errors the session but keeps the server", () => {
  it("wrong-key token → session error, listener survives for the live attempt", async () => {
    const started = await startTestProxy();
    const live = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const other = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const state = `wrongkey-state-${Date.now()}`;
    registerZedSession({ state, codeVerifier: live.privateKeyVerifier });

    // Token encrypted for a DIFFERENT keypair (e.g. superseded popup).
    const bad = encryptForCallback(other.publicKey, "not-for-this-key");
    const cb = new URL(`http://127.0.0.1:${started.port}/`);
    cb.searchParams.set("user_id", "user-123");
    cb.searchParams.set("access_token", bad);
    const res = await realFetch(cb.toString());
    expect(res.status).toBe(200);

    const session = getZedSessionStatus(state);
    expect(session).not.toBeNull();
    expect(session.status).toBe("error");
    expect(session.error).toMatch(/decrypt/i);

    // Server must still be alive (same port) for the live attempt.
    const again = await startZedProxy(0);
    expect(again.port).toBe(started.port);
    clearZedSession(state);
  });
});
