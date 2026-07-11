import { afterEach, describe, expect, it, vi } from "vitest";

import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

afterEach(() => vi.unstubAllGlobals());

function abortableFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

describe("non-chat combo abort propagation", () => {
  it("aborts a web-fetch provider when the caller disconnects", async () => {
    const caller = new AbortController();
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      upstreamSignal = init.signal;
      return abortableFetch(url, init);
    }));

    const resultPromise = handleFetchCore({
      url: "https://example.com/article",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 10_000 },
      abortSignal: caller.signal,
    });
    caller.abort();

    await expect(resultPromise).resolves.toMatchObject({ success: false, status: 504 });
    expect(upstreamSignal.aborted).toBe(true);
  });

  it("aborts a dedicated search provider when the caller disconnects", async () => {
    const caller = new AbortController();
    let upstreamSignal;
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      upstreamSignal = init.signal;
      return abortableFetch(url, init);
    }));

    const resultPromise = handleSearchCore({
      body: { query: "switchboard", max_results: 3 },
      provider: { id: "brave" },
      providerConfig: {
        authType: "none",
        baseUrl: "https://example.com/search",
        timeoutMs: 10_000,
      },
      credentials: null,
      abortSignal: caller.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    caller.abort();

    await expect(resultPromise).resolves.toMatchObject({ success: false, status: 504 });
    expect(upstreamSignal.aborted).toBe(true);
  });
});
