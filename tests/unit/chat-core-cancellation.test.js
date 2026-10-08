import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
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
beforeEach(() => { mocks.execute.mockReset(); mocks.refresh.mockReset(); });
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
