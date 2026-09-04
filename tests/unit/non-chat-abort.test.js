import { afterEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

afterEach(() => {
  proxyAwareFetch.mockReset();
  vi.unstubAllGlobals();
});

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
    proxyAwareFetch.mockImplementation((url, init) => {
      upstreamSignal = init.signal;
      return abortableFetch(url, init);
    });

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

  it("aborts STT provider fetch when the caller disconnects", async () => {
    const caller = new AbortController();
    let upstreamSignal;
    proxyAwareFetch.mockImplementation((url, init) => {
      upstreamSignal = init.signal;
      return abortableFetch(url, init);
    });
    const formData = new FormData();
    formData.append("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");
    const resultPromise = handleSttCore({
      provider: "deepgram",
      model: "nova",
      formData,
      credentials: { apiKey: "provider-key" },
      sttConfig: { format: "deepgram", baseUrl: "https://example.com/listen", authHeader: "token" },
      abortSignal: caller.signal,
    });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    caller.abort();
    await expect(resultPromise).resolves.toMatchObject({ success: false });
    expect(upstreamSignal.aborted).toBe(true);
  });

  it("rejects an already-aborted AssemblyAI polling delay without polling or waiting", async () => {
    const caller = new AbortController();
    proxyAwareFetch
      .mockResolvedValueOnce(Response.json({ upload_url: "https://upload.test/audio" }))
      .mockImplementationOnce(async () => {
        caller.abort();
        return Response.json({ id: "transcript-1" });
      });
    const formData = new FormData();
    formData.append("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");

    const startedAt = Date.now();
    const result = await handleSttCore({
      provider: "assemblyai",
      model: "universal",
      formData,
      credentials: { apiKey: "provider-key" },
      sttConfig: { format: "assemblyai", baseUrl: "https://api.assemblyai.com/v2/transcript", authHeader: "authorization" },
      abortSignal: caller.signal,
    });

    expect(result).toMatchObject({ success: false, status: 499 });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
