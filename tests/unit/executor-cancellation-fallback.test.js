import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const execute = (executor, signal) => executor.execute({ model: "model", body: {}, stream: false, credentials: { apiKey: "synthetic-key" }, signal });
const response = status => new Response("{}", { status });
afterEach(() => { vi.useRealTimers(); mocks.fetch.mockReset(); });
describe("executor cancellation and fallback", () => {
  it("cancels a successful response arriving after the caller aborted", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    mocks.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(new ReadableStream({ cancel }));
    });
    const executor = new BaseExecutor("test", { baseUrls: ["https://first.test/api", "https://second.test/api"] });
    await expect(execute(executor, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not invoke transport for a caller already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    mocks.fetch.mockResolvedValue(response(200));
    const result = await execute(new BaseExecutor("test", { baseUrl: "https://upstream.test/api" }), controller.signal).then(value => ({ value }), error => ({ error }));
    expect(result.error?.name).toBe("AbortError");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not switch URLs when cancellation interrupts the 429 retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const executor = new BaseExecutor("test", {
      baseUrls: ["https://first.test/api", "https://second.test/api"], retry: { 429: { attempts: 1, delayMs: 5000 } },
    });
    mocks.fetch.mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(200));
    const pending = execute(executor, controller.signal).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    const result = await pending;
    expect(result.error?.name).toBe("AbortError");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry a generic transport error when the caller has canceled", async () => {
    const controller = new AbortController();
    const executor = new BaseExecutor("test", { baseUrls: ["https://first.test/api", "https://second.test/api"], retry: { 502: { attempts: 0 } } });
    mocks.fetch.mockImplementationOnce(async () => { controller.abort(); throw new Error("transport closed"); }).mockResolvedValueOnce(response(200));
    const result = await execute(executor, controller.signal).then(value => ({ value }), error => ({ error }));
    expect(result.error?.name).toBe("AbortError");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
