import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getModelInfo: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
}));
vi.mock("../../src/sse/initOpenSseDeps.js", () => ({}));


vi.mock("@/lib/db/index.js", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getConnectionInFlightCount: (connectionId) => Object.values(
    global._pendingRequests?.byAccount?.[connectionId] || {},
  ).reduce((total, count) => total + (Number.isFinite(count) && count > 0 ? count : 0), 0),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: mocks.handleEmbeddingsCore,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/clientKeyPolicy.js", () => ({
  authorizeClientKeyRequest: vi.fn(async () => ({ ok: true, clientKeyId: "client-a", lease: null })),
  runWithClientKeyLease: async (_lease, work) => work(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn(),
}));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { __resetAccountSchedulerForTests } = await import("../../src/sse/services/accountScheduler.js");

const request = () => new Request("http://localhost/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  global._pendingRequests.byModel = {};
  global._pendingRequests.byAccount = {};
  __resetAccountSchedulerForTests();
  mocks.getSettings.mockResolvedValue({
    providerStrategies: {
      openai: { accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 60 } },
    },
  });
  mocks.getProviderConnections.mockResolvedValue([{
    id: "c1",
    provider: "openai",
    priority: 1,
    maxConcurrentRequests: 1,
    apiKey: "provider-key",
    providerSpecificData: {},
  }]);
  mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" });
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
});

it("holds a non-chat stream at cap one, rejects overlap, and admits after EOF release", async () => {
  const controllers = [];
  mocks.handleEmbeddingsCore.mockImplementation(async () => ({
    success: true,
    response: new Response(new ReadableStream({
      start(controller) {
        controllers.push(controller);
      },
    })),
  }));

  const first = await handleEmbeddings(request());
  const overlapping = await handleEmbeddings(request());
  expect(overlapping.status).toBe(429);
  expect(mocks.handleEmbeddingsCore).toHaveBeenCalledOnce();

  controllers[0].enqueue(new TextEncoder().encode("first"));
  controllers[0].close();
  await expect(first.text()).resolves.toBe("first");

  const admitted = await handleEmbeddings(request());
  expect(admitted.status).toBe(200);
  expect(mocks.handleEmbeddingsCore).toHaveBeenCalledTimes(2);
  controllers[1].close();
  await admitted.text();
});
