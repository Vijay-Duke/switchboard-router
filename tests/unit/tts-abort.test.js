// H51–H56 — abort signal forwarding, 15s timeouts, self-hosted URL validation,
// elevenlabs voices cache bound, google RPC shape guard, gemini prompt heuristic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { fetchElevenLabsVoices, ELEVENLABS_VOICES_CACHE_MAX } from "../../open-sse/handlers/ttsProviders/elevenlabs.js";
import { buildPrompt } from "../../open-sse/handlers/ttsProviders/gemini.js";

function abortableFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) return fail();
    init.signal?.addEventListener("abort", fail, { once: true });
  });
}

beforeEach(() => { proxyAwareFetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("abort signal reaches every adapter (H51)", () => {
  it.each([
    ["openai", "tts-1/alloy"],
    ["elevenlabs", "voice-1"],
    ["gemini", "Kore"],
    ["openrouter", "gpt-4o-mini-tts/alloy"],
    ["cartesia", "sonic-2/voice-1"],
  ])("%s forwards the caller signal", async (provider, model) => {
    const caller = new AbortController();
    caller.abort();
    proxyAwareFetch.mockImplementation(abortableFetch);
    const result = await handleTtsCore({ provider, model, input: "hi", credentials: { apiKey: "k" }, abortSignal: caller.signal });
    expect(result.success).toBe(false);
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    expect(proxyAwareFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("scrape/synth hops are bounded (H52)", () => {
  it.each(["edge-tts", "google-tts"])("%s applies a 15s timeout signal", async (provider) => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchMock = vi.fn((url, init) => {
      queueMicrotask(() => timeout.abort());
      return abortableFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleTtsCore({ provider, model: undefined, input: "hi", credentials: null });
    expect(result.success).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(15000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("self-hosted base URL (H53)", () => {
  it("garbage base URL → 400, not 502", async () => {
    const result = await handleTtsCore({
      provider: "selfhosted-tts", model: "m", input: "hi",
      credentials: { providerSpecificData: { baseUrl: "not a url" } },
    });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("elevenlabs voices cache is bounded (H54)", () => {
  it("evicts the oldest key once the cap is exceeded", async () => {
    proxyAwareFetch.mockImplementation(async () => Response.json({ voices: [{ voice_id: "v" }] }));
    for (let i = 0; i <= ELEVENLABS_VOICES_CACHE_MAX; i++) await fetchElevenLabsVoices(`key-${i}`);
    const calls = proxyAwareFetch.mock.calls.length;
    await fetchElevenLabsVoices(`key-${ELEVENLABS_VOICES_CACHE_MAX}`); // newest: still cached
    expect(proxyAwareFetch.mock.calls.length).toBe(calls);
    await fetchElevenLabsVoices("key-0"); // oldest: evicted → refetch
    expect(proxyAwareFetch.mock.calls.length).toBe(calls + 1);
  });
});

describe("google-tts RPC envelope guard (H55)", () => {
  it("unexpected response shape → clear format-changed error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url) === "https://translate.google.com/") {
        return new Response('"FdrFJe":"sid" "cfb2h":"bl"', { status: 200 });
      }
      return new Response("garbage without envelope", { status: 200 });
    }));
    const result = await handleTtsCore({ provider: "google-tts", model: "en", input: "hi", credentials: null });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/token\/format changed/);
  });
});

describe("gemini TTS prompt prefix (H56)", () => {
  it("prose with a colon still gets the Say: prefix", () => {
    expect(buildPrompt("Note: the meeting moved")).toBe("Say: Note: the meeting moved");
    expect(buildPrompt("hello", "French")).toBe("Say in French: hello");
  });
  it("explicit speak instructions are left alone", () => {
    expect(buildPrompt("Say cheerfully: hello")).toBe("Say cheerfully: hello");
    expect(buildPrompt("Whisper: psst")).toBe("Whisper: psst");
  });
});
