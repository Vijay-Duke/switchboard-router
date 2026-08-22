import { afterEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { handleEmbeddingsCore } = await import("open-sse/handlers/embeddingsCore.js");
const { runWithClientKeyLease } = await import("@/sse/services/clientKeyPolicy.js");

afterEach(() => {
  proxyAwareFetch.mockReset();
  vi.unstubAllGlobals();
});

describe("embeddings abort propagation", () => {
  it("cancels upstream fetch and releases the client-key lease once", async () => {
    const caller = new AbortController();
    let upstreamSignal;
    proxyAwareFetch.mockImplementation((_url, { signal }) => {
      upstreamSignal = signal;
      if (signal.aborted) {
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true }));
    });
    const release = vi.fn();
    const promise = runWithClientKeyLease({ release }, async () => {
      const result = await handleEmbeddingsCore({
        body: { input: "hello" },
        modelInfo: { provider: "openai", model: "text-embedding-3-small" },
        credentials: { apiKey: "provider-secret" },
        log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
        abortSignal: caller.signal,
      });
      return result.response;
    });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    caller.abort();
    await expect(promise).resolves.toBeInstanceOf(Response);
    expect(upstreamSignal.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
