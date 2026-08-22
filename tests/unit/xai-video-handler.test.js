/**
 * Unit tests for the app-side video handler (src/sse/handlers/videoGeneration.js)
 *
 * Covers:
 *  - `xai/` model prefix stripping before the body is forwarded upstream
 *  - byte-exact forwarding when no prefix rewrite is needed
 *  - multi-account selection (preferred connection id, rotation on 401)
 *  - NO rotation on 5xx creation errors (a job may already exist upstream)
 *  - connection id surfaced via x-switchboard-connection-id
 *  - GET polling pinned to x-connection-id, no rotation
 *  - refresh failure recorded via markAccountUnavailable (dashboard re-auth signal)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);

const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);

vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: vi.fn(async () => ({ ok: true, mode: "local", clientKeyId: null, lease: null })),
  runWithClientKeyLease: (_lease, work) => work(),
}));

vi.mock("@/sse/services/connectionInFlight.js", () => ({
  withConnectionInFlight: (_opts, work) => work(),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (s) => {
    if (typeof s === "string" && s.includes("/")) {
      const idx = s.indexOf("/");
      return { provider: s.slice(0, idx), model: s.slice(idx + 1) };
    }
    // Combos and bare ids surface as provider-less to callers
    return { provider: null, model: s };
  }),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
}));

vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { handleVideoCreate, handleVideoGet } from "../../src/sse/handlers/videoGeneration.js";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const makeRequest = (body, { headers = {}, contentType = "application/json" } = {}) =>
  new Request("http://localhost/v1/videos/generations", {
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const account = (overrides = {}) => ({
  connectionId: "conn-1",
  accessToken: "tok-1",
  refreshToken: "ref-1",
  authType: "oauth",
  ...overrides,
});

beforeEach(() => {
  proxyAwareFetch.mockReset();
  authMocks.getProviderCredentials.mockReset();
  authMocks.markAccountUnavailable.mockClear();
  authMocks.clearAccountError.mockClear();
  tokenMocks.checkAndRefreshToken.mockClear();
});

describe("handleVideoCreate", () => {
  it("strips the xai/ prefix from model before forwarding", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const res = await handleVideoCreate(
      makeRequest({ model: "xai/grok-imagine-video", prompt: "a cat" }),
      "generations"
    );

    expect(res.status).toBe(200);
    const forwarded = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(forwarded.model).toBe("grok-imagine-video");
    expect(forwarded.prompt).toBe("a cat");
  });

  it("forwards the original raw JSON bytes when no rewrite is needed", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    // Odd spacing survives only if we forward the raw string untouched
    const raw = '{ "model" : "grok-imagine-video",  "prompt" : "spaced" }';
    await handleVideoCreate(makeRequest(raw), "generations");

    expect(proxyAwareFetch.mock.calls[0][1].body).toBe(raw);
  });

  it("rejects providers without video support", async () => {
    const res = await handleVideoCreate(
      makeRequest({ model: "openai/sora-alike", prompt: "x" }),
      "generations"
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not support video generation");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns the serving connection id in x-switchboard-connection-id", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-77" }));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");
    expect(res.headers.get("x-switchboard-connection-id")).toBe("conn-77");
    expect(await res.json()).toEqual({ request_id: "r1" });
  });

  it("honors preferred x-connection-id when selecting the account", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ request_id: "r1" }));

    await handleVideoCreate(
      makeRequest({ prompt: "x" }, { headers: { "x-connection-id": "conn-9" } }),
      "generations"
    );

    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai", expect.anything(), null, expect.objectContaining({ preferredConnectionId: "conn-9" })
    );
  });

  it("rotates to the next account on 401 (auth errors cannot have created a job)", async () => {
    authMocks.getProviderCredentials
      .mockResolvedValueOnce(account({ connectionId: "conn-1", refreshToken: null }))
      .mockResolvedValueOnce(account({ connectionId: "conn-2", accessToken: "tok-2", refreshToken: null }));
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ request_id: "r2" }));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-switchboard-connection-id")).toBe("conn-2");
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1", 401, expect.any(String), "xai", null
    );
  });

  it("does NOT rotate accounts on a 500 creation error (job may exist upstream)", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ refreshToken: null }));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");

    expect(res.status).toBe(500);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(authMocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("forwards multipart bodies byte-exact with default xai provider", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account());
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ request_id: "r-mp" }));

    const boundary = "----handlerBoundary";
    const raw = `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit\r\n--${boundary}--\r\n`;
    const req = new Request("http://localhost/v1/videos/edits", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: raw,
    });

    const res = await handleVideoCreate(req, "edits");
    expect(res.status).toBe(200);

    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/edits");
    expect(Buffer.from(init.body).toString()).toBe(raw);
    expect(init.headers["Content-Type"]).toContain(boundary);
  });

  it("returns 400 when no credentials are connected", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(null);
    const res = await handleVideoCreate(makeRequest({ prompt: "x" }), "generations");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("No credentials for provider: xai");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await handleVideoCreate(makeRequest("{not json"), "generations");
    expect(res.status).toBe(400);
  });
});

describe("handleVideoGet", () => {
  it("polls upstream pinned to the x-connection-id account and passes status through", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ connectionId: "conn-5" }));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ status: "pending", progress: 42 }));

    const req = new Request("http://localhost/v1/videos/req-1", {
      headers: { "x-connection-id": "conn-5" },
    });
    const res = await handleVideoGet(req, "req-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending", progress: 42 });
    expect(authMocks.getProviderCredentials).toHaveBeenCalledWith(
      "xai", null, null, expect.objectContaining({ preferredConnectionId: "conn-5" })
    );
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://api.x.ai/v1/videos/req-1");
  });

  it("records the failure when polling hits a terminal auth error", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(account({ refreshToken: null }));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));

    const res = await handleVideoGet(new Request("http://localhost/v1/videos/req-1"), "req-1");

    expect(res.status).toBe(401);
    expect(authMocks.markAccountUnavailable).toHaveBeenCalled();
  });
});
