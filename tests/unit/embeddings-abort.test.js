import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: vi.fn() }));

const { handleEmbeddingsCore } = await import("open-sse/handlers/embeddingsCore.js");
const { runWithClientKeyLease } = await import("@/sse/services/clientKeyPolicy.js");

afterEach(() => vi.unstubAllGlobals());

describe("embeddings abort propagation", () => {
  it("cancels upstream fetch and releases the client-key lease once", async () => {
    const caller = new AbortController();
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      upstreamSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true }));
    }));
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
