import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute, refreshCredentials: mocks.refresh, noAuth: false }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logError: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), close: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: () => null, harvestDetectedClient: () => false, isNativePassthrough: () => false,
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...await importOriginal(), proxyAwareFetch: mocks.fetch,
}));
const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
let sequence = 0;
const options = signal => ({
  modelInfo: { provider: "openai", model: "gpt-4.1" },
  credentials: { apiKey: "synthetic-key", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", connectionId: `synthetic-${++sequence}` },
  body: { messages: [{ role: "user", content: "hello" }], stream: false },
  sourceFormatOverride: "openai", abortSignal: signal,
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false,
});
beforeEach(() => { mocks.execute.mockReset(); mocks.refresh.mockReset(); mocks.fetch.mockReset(); });
describe("core cancellation classification", () => {
  it("persists a completed rotation after cancellation without another inference", async () => {
    const controller = new AbortController(), persisted = vi.fn();
    mocks.execute.mockResolvedValueOnce({ response: new Response("unauthorized", { status: 401 }), headers: {}, url: "https://upstream.test/api", transformedBody: {} });
    mocks.refresh.mockImplementationOnce(async () => {
      controller.abort();
      return { accessToken: "new-access", refreshToken: "new-refresh" };
    });
    const result = await handleChatCore({ ...options(controller.signal), onCredentialsRefreshed: persisted });
    expect(result.status).toBe(499);
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "new-access", refreshToken: "new-refresh" }));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not retry an unsuccessful refresh after cancellation", async () => {
    const controller = new AbortController();
    mocks.execute.mockResolvedValueOnce({ response: new Response("unauthorized", { status: 401 }), headers: {}, url: "https://upstream.test/api", transformedBody: {} });
    mocks.refresh.mockImplementationOnce(async () => { controller.abort(); return null; });
    const result = await handleChatCore(options(controller.signal));
    expect(result.status).toBe(499);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not execute a provider for an already canceled caller", async () => {
    const controller = new AbortController(); controller.abort();
    mocks.execute.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const result = await handleChatCore(options(controller.signal));
    expect(result.status).toBe(499);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("classifies a transport's generic close error as cancellation when caller canceled", async () => {
    const controller = new AbortController();
    mocks.execute.mockImplementationOnce(async () => { controller.abort(new Error("caller timeout")); throw new Error("transport closed"); });
    const result = await handleChatCore(options(controller.signal));
    expect(result.status).toBe(499);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("does not refresh or retry a 401 response arriving after caller cancellation", async () => {
    const controller = new AbortController();
    mocks.execute.mockImplementationOnce(async () => {
      controller.abort();
      return { response: new Response("unauthorized", { status: 401 }), headers: {}, url: "https://upstream.test/api", transformedBody: {} };
    }).mockImplementationOnce(async () => ({ response: Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }), headers: {}, url: "https://upstream.test/api", transformedBody: {} }));
    mocks.refresh.mockResolvedValue({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    const result = await handleChatCore(options(controller.signal));
    expect(result.status).toBe(499);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

describe("provider connect deadlines", () => {
  const timeoutTransport = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(new DOMException("connect aborted", "AbortError")), { once: true });
  });
  it("reports an exhausted internal deadline as502 while the caller remains connected", async () => {
    const controller = new AbortController();
    const executor = new BaseExecutor("openai", { baseUrl: "https://upstream.test/api", timeoutMs: 10, retry: { 502: { attempts: 0 } } });
    mocks.fetch.mockImplementation(timeoutTransport);
    mocks.execute.mockImplementation(args => executor.execute(args));
    const result = await handleChatCore(options(controller.signal));
    expect(result.status).toBe(502);
    expect(controller.signal.aborted).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps fallback available for an internal deadline while the caller remains connected", async () => {
    const controller = new AbortController();
    const executor = new BaseExecutor("openai", { baseUrls: ["https://first.test/api", "https://second.test/api"], timeoutMs: 10, retry: { 502: { attempts: 0 } } });
    mocks.fetch.mockImplementationOnce(timeoutTransport).mockResolvedValueOnce(Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    mocks.execute.mockImplementation(args => executor.execute(args));
    const result = await handleChatCore(options(controller.signal));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(controller.signal.aborted).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("refresh retry cancellation scope", () => {
  it("keeps an upstream abort retryable when its caller is still connected", async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn().mockRejectedValueOnce(new DOMException("upstream deadline", "AbortError")).mockResolvedValueOnce({ accessToken: "new-access" });
      const pending = refreshWithRetry(refresh, 2, null, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({ accessToken: "new-access" });
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("stops retry backoff immediately when its caller cancels", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(), refresh = vi.fn().mockResolvedValue(null);
      const pending = refreshWithRetry(refresh, 3, null, controller.signal).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect((await pending).error.name).toBe("AbortError");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
