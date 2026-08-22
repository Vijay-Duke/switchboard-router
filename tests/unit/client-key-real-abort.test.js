import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  getClientKeySpend: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  embeddingsCore: vi.fn(),
  sttCore: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
  getClientKeySpend: mocks.getClientKeySpend,
  getSettings: mocks.getSettings,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: vi.fn(() => false) }));
vi.mock("@/shared/utils/cliToken.js", () => ({ hasValidCliToken: vi.fn(async () => false) }));
vi.mock("@/sse/initOpenSseDeps.js", () => ({}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.embeddingsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.sttCore }));

const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { handleStt } = await import("@/sse/handlers/stt.js");
const policy = await import("@/sse/services/clientKeyPolicy.js");

const KEY = "sk-real-abort-test";
const CLIENT_KEY = {
  id: "abort-client",
  keyPrefix: "sk-real-ab…",
  name: "Abort proof",
  isActive: true,
  allowedModels: [],
  allowedCombos: [],
  expiresAt: null,
  rateLimitPerMinute: null,
  concurrencyLimit: 1,
  spendLimitUsd: null,
  spentUsd: 0,
};

function embeddingsRequest(controller = new AbortController()) {
  return new Request("https://router.test/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "openai/embed", input: "hello" }),
    signal: controller.signal,
  });
}

function sttRequest(controller = new AbortController()) {
  const form = new FormData();
  form.set("model", "deepgram/nova");
  form.set("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");
  return new Request("https://router.test/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
    body: form,
    signal: controller.signal,
  });
}

function stalledCore(started) {
  return ({ abortSignal }) => new Promise((resolve) => {
    started();
    if (abortSignal.aborted) {
      resolve({ success: false, status: 499, error: "aborted", response: new Response("aborted", { status: 499 }) });
      return;
    }
    abortSignal.addEventListener("abort", () => {
      resolve({ success: false, status: 499, error: "aborted", response: new Response("aborted", { status: 499 }) });
    }, { once: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  policy.__resetClientKeyPolicyStateForTests();
  mocks.authenticateApiKey.mockResolvedValue({ ...CLIENT_KEY });
  mocks.getClientKeySpend.mockResolvedValue(0);
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  mocks.getProviderCredentials.mockResolvedValue({
    connectionId: "provider-1",
    connectionName: "Provider one",
    apiKey: "provider-secret",
    providerSpecificData: {},
  });
  mocks.getModelInfo.mockImplementation(async (model) => {
    const [provider, id] = model.split("/");
    return { provider, model: id };
  });
});

describe.each([
  {
    name: "embeddings",
    core: mocks.embeddingsCore,
    request: embeddingsRequest,
    handle: handleEmbeddings,
  },
  {
    name: "STT",
    core: mocks.sttCore,
    request: sttRequest,
    handle: handleStt,
  },
])("real $name handler abort and lease", ({ core, request, handle }) => {
  it("cancels stalled work, returns 499 before fallback, releases once, and admits the next request", async () => {
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    core.mockImplementationOnce(stalledCore(notifyStarted));
    const firstController = new AbortController();
    const first = handle(request(firstController));
    await started;

    const blocked = await handle(request());
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("client_key_concurrency_limit_exceeded");

    firstController.abort();
    const aborted = await first;
    expect(aborted.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();

    core.mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200 }) });
    const next = await handle(request());
    expect(next.status).toBe(200);
    expect(await next.text()).toBe("ok");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});
