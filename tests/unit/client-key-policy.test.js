import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  getClientKeySpend: vi.fn(),
  getCombos: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  isLocalRequest: vi.fn(),
  hasValidCliToken: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
  getClientKeySpend: mocks.getClientKeySpend,
  getCombos: mocks.getCombos,
  getSettings: async () => ({ requireApiKey: true }),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: mocks.hasValidCliToken }));

const policy = await import("@/sse/services/clientKeyPolicy.js");
const { withModelCatalogPolicy } = await import("@/sse/services/modelCatalogPolicy.js");

const RAW_KEY = "sk-policy-super-secret";
const baseKey = {
  id: "client-1",
  keyPrefix: "sk-policy…",
  name: "Policy key",
  machineId: null,
  isActive: true,
  createdAt: "2026-08-22T00:00:00.000Z",
  allowedModels: [],
  allowedCombos: [],
  expiresAt: null,
  rateLimitPerMinute: null,
  concurrencyLimit: null,
  spendLimitUsd: null,
  spentUsd: 0,
  tokenLimit: null,
  usedTokens: 0,
};

function request() {
  return new Request("https://switchboard.example/v1/chat/completions");
}

async function authorize(overrides = {}) {
  return policy.authorizeClientKeyRequest({
    settings: { requireApiKey: true },
    rawKey: RAW_KEY,
    request: request(),
    target: { kind: "model", id: "gpt-5" },
    ...overrides,
  });
}

async function errorCode(result) {
  return (await result.response.json()).error.code;
}

beforeEach(() => {
  vi.useRealTimers();
  policy.__resetClientKeyPolicyStateForTests();
  mocks.authenticateApiKey.mockReset().mockResolvedValue({ ...baseKey });
  mocks.getClientKeySpend.mockReset().mockResolvedValue(0);
  mocks.getCombos.mockReset().mockResolvedValue([{ name: "fast" }]);
  mocks.getModelInfo.mockReset().mockImplementation(async (modelStr) => {
    // Bare names resolve through the default provider; provider-prefixed ids
    // resolve to that provider (mirrors src/sse/services/model.js semantics).
    if (typeof modelStr !== "string" || !modelStr) return null;
    if (modelStr.includes("/")) {
      const [provider, model] = modelStr.split("/");
      return { provider, model };
    }
    return { provider: "openai", model: modelStr };
  });
  mocks.getComboModels.mockReset().mockImplementation(async (modelStr) =>
    modelStr === "fast" ? ["openai/gpt-5"] : null
  );
  mocks.isLocalRequest.mockReset().mockReturnValue(false);
  mocks.hasValidCliToken.mockReset().mockResolvedValue(false);
});

describe("authorizeClientKeyRequest", () => {
  it("catalog reads neither consume the inference rate budget nor require spare quota", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, rateLimitPerMinute: 1, tokenLimit: 10, usedTokens: 10, spendLimitUsd: 0 });
    const catalogRequest = () => new Request("https://switchboard.example/v1/models", { headers: { Authorization: `Bearer ${RAW_KEY}` } });
    for (let i = 0; i < 3; i++) {
      const result = await withModelCatalogPolicy(catalogRequest(), async () => new Response("catalog"));
      expect(result.status).toBe(200);
    }
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, rateLimitPerMinute: 1 });
    const inference = await authorize();
    expect(inference.ok).toBe(true);
    inference.lease.release();
    expect(await errorCode(await authorize())).toBe("client_key_rate_limit_exceeded");
  });

  it("catalog reads do not reserve or require an inference concurrency slot", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, concurrencyLimit: 1 });
    let finish;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const catalog = withModelCatalogPolicy(new Request("https://switchboard.example/v1/models", { headers: { Authorization: `Bearer ${RAW_KEY}` } }), async () => {
      signalStarted();
      return new Promise((resolve) => { finish = () => resolve(new Response("catalog")); });
    });
    await started;
    const inference = await authorize();
    expect(inference.ok).toBe(true);
    const secondCatalog = await withModelCatalogPolicy(new Request("https://switchboard.example/v1/models", { headers: { Authorization: `Bearer ${RAW_KEY}` } }), async () => new Response("catalog"));
    expect(secondCatalog.status).toBe(200);
    inference.lease.release();
    finish();
    expect((await catalog).status).toBe(200);
  });
  it("bypasses policy for verified loopback and CLI traffic before inspecting a supplied key", async () => {
    mocks.isLocalRequest.mockReturnValue(true);
    expect(await authorize()).toEqual({ ok: true, mode: "local", clientKey: null, clientKeyId: null, lease: null });
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();

    mocks.isLocalRequest.mockReturnValue(false);
    mocks.hasValidCliToken.mockResolvedValue(true);
    expect(await authorize()).toEqual({ ok: true, mode: "cli", clientKey: null, clientKeyId: null, lease: null });
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();
  });

  it("preserves required and optional missing/invalid key behavior", async () => {
    const missingRequired = await authorize({ rawKey: null });
    expect(missingRequired.response.status).toBe(401);
    expect(await errorCode(missingRequired)).toBe("missing_api_key");
    expect(await authorize({ settings: { requireApiKey: false }, rawKey: null })).toEqual({
      ok: true, mode: "local", clientKey: null, clientKeyId: null, lease: null,
    });

    mocks.authenticateApiKey.mockResolvedValue(null);
    const invalidRequired = await authorize();
    expect(invalidRequired.response.status).toBe(401);
    expect(await errorCode(invalidRequired)).toBe("invalid_api_key");
    expect(await authorize({ settings: { requireApiKey: false } })).toEqual({
      ok: true, mode: "local", clientKey: null, clientKeyId: null, lease: null,
    });
  });

  it("rejects expiration equality and enforces model/combo allowlists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, expiresAt: "2026-08-22T12:00:00.000Z" });
    expect(await errorCode(await authorize())).toBe("client_key_expired");

    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, allowedModels: ["gpt-5"], allowedCombos: ["fast"] });
    expect((await authorize()).ok).toBe(true);
    expect(await errorCode(await authorize({ target: { kind: "model", id: "gpt-4" } }))).toBe("client_key_target_not_allowed");
    expect((await authorize({ target: { kind: "combo", id: "fast" } })).ok).toBe(true);
    expect(await errorCode(await authorize({ target: { kind: "combo", id: "slow" } }))).toBe("client_key_target_not_allowed");
  });

  it("rejects already-spent keys at equality without disclosing secret or limits", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, spendLimitUsd: 5 });
    mocks.getClientKeySpend.mockResolvedValue(5);
    const result = await authorize();
    expect(result.response.status).toBe(429);
    expect(await errorCode(result)).toBe("client_key_spend_limit_exceeded");
    const body = await (await authorize()).response.text();
    expect(body).not.toContain(RAW_KEY);
    expect(body).not.toContain(baseKey.name);
    expect(body).not.toContain("5");
  });

  it("rejects a KNOWN paused key even when keys are optional; unknown keys keep the local pass", async () => {
    // includeInactive lookup surfaces paused keys as KNOWN (mirrors the repo).
    mocks.authenticateApiKey.mockImplementation(async (raw, { includeInactive } = {}) =>
      includeInactive ? { ...baseKey, isActive: false } : null);
    const pausedOptional = await authorize({ settings: { requireApiKey: false } });
    expect(pausedOptional.ok).toBe(false);
    expect(pausedOptional.response.status).toBe(401);
    expect(await errorCode(pausedOptional)).toBe("client_key_paused");

    const pausedRequired = await authorize({ settings: { requireApiKey: true } });
    expect(await errorCode(pausedRequired)).toBe("client_key_paused");

    // Unknown key: optional-auth local pass is preserved.
    mocks.authenticateApiKey.mockResolvedValue(null);
    expect(await authorize({ settings: { requireApiKey: false } })).toEqual({
      ok: true, mode: "local", clientKey: null, clientKeyId: null, lease: null,
    });
  });

  it("enforces the per-key token quota with 429 at equality and discloses only counts", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, tokenLimit: 1_000, usedTokens: 999 });
    expect((await authorize()).ok).toBe(true);

    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, tokenLimit: 1_000, usedTokens: 1_000 });
    const exhausted = await authorize();
    expect(exhausted.response.status).toBe(429);
    const body = await exhausted.response.text();
    expect(JSON.parse(body).error.code).toBe("client_key_token_quota_exceeded");
    expect(body).toContain("1,000");
    expect(body).not.toContain(RAW_KEY);
    expect(body).not.toContain(baseKey.name);

    // Quota applies to known keys even in optional-auth mode.
    const optionalAuth = await authorize({ settings: { requireApiKey: false } });
    expect(optionalAuth.ok).toBe(false);
    expect(await errorCode(optionalAuth)).toBe("client_key_token_quota_exceeded");
  });

  it("enforces concurrency before rate and releases with an idempotent lease", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, concurrencyLimit: 1, rateLimitPerMinute: 10 });
    const first = await authorize();
    expect(first.ok).toBe(true);
    const blocked = await authorize();
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toBe("1");
    expect(await errorCode(blocked)).toBe("client_key_concurrency_limit_exceeded");

    first.lease.release();
    first.lease.release();
    expect((await authorize()).ok).toBe(true);
  });

  it("uses fixed per-key 60-second windows with isolated counters and Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    mocks.authenticateApiKey.mockImplementation(async (raw) => ({
      ...baseKey,
      id: raw === "second" ? "client-2" : "client-1",
      rateLimitPerMinute: 2,
    }));
    const first = await authorize(); first.lease.release();
    vi.advanceTimersByTime(1_500);
    const second = await authorize(); second.lease.release();
    const blocked = await authorize();
    expect(await errorCode(blocked)).toBe("client_key_rate_limit_exceeded");
    expect(blocked.response.headers.get("retry-after")).toBe("59");
    expect((await authorize({ rawKey: "second" })).ok).toBe(true);

    vi.advanceTimersByTime(58_500);
    expect((await authorize()).ok).toBe(true);
  });

  it("reset clears process-local rate and in-flight state", async () => {
    mocks.authenticateApiKey.mockResolvedValue({ ...baseKey, concurrencyLimit: 1, rateLimitPerMinute: 1 });
    expect((await authorize()).ok).toBe(true);
    expect((await authorize()).ok).toBe(false);
    policy.__resetClientKeyPolicyStateForTests();
    expect((await authorize()).ok).toBe(true);
  });
});

describe("runWithClientKeyLease", () => {
  it("releases non-SSE success and thrown work exactly once", async () => {
    const release = vi.fn();
    const response = new Response("ok", { status: 201 });
    expect(await policy.runWithClientKeyLease({ release }, async () => response)).toBe(response);
    expect(release).toHaveBeenCalledOnce();

    release.mockClear();
    await expect(policy.runWithClientKeyLease({ release }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves SSE metadata/bytes and delays one release until EOF", async () => {
    const release = vi.fn();
    const bytes = new TextEncoder().encode("data: hello\n\ndata: [DONE]\n\n");
    const source = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const wrapped = await policy.runWithClientKeyLease({ release }, async () => new Response(source, {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "text/event-stream", "x-test": "preserved" },
    }));
    expect(wrapped.status).toBe(202);
    expect(wrapped.statusText).toBe("Accepted");
    expect(wrapped.headers.get("x-test")).toBe("preserved");
    expect(release).not.toHaveBeenCalled();
    expect(new Uint8Array(await wrapped.arrayBuffer())).toEqual(bytes);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases once and cancels the SSE source when the consumer cancels", async () => {
    const release = vi.fn();
    const cancel = vi.fn();
    const source = new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("data: open\n\n")); },
      cancel,
    });
    const wrapped = await policy.runWithClientKeyLease({ release }, async () => new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }));
    const reader = wrapped.body.getReader();
    await reader.read();
    expect(release).not.toHaveBeenCalled();
    await reader.cancel("client aborted");
    expect(cancel).toHaveBeenCalledWith("client aborted");
    expect(release).toHaveBeenCalledOnce();
    await reader.cancel("again");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases once when the SSE source errors", async () => {
    const release = vi.fn();
    const source = new ReadableStream({ start(controller) { controller.error(new Error("source failed")); } });
    const wrapped = await policy.runWithClientKeyLease({ release }, async () => new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }));
    await expect(wrapped.body.getReader().read()).rejects.toThrow("source failed");
    expect(release).toHaveBeenCalledOnce();
  });
});
