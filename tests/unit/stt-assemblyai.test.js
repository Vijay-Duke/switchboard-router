// H57/H58/H59 — AssemblyAI fail-fast polling, 413 upload cap, gemini key encoding.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

const formWith = (file) => ({ get: (k) => (k === "file" ? file : null) });
const smallFile = () => new File([new Uint8Array(16)], "audio.wav", { type: "audio/wav" });

beforeEach(() => { proxyAwareFetch.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("AssemblyAI polling (H57)", () => {
  it("401 on poll fails fast instead of retrying for 120s", async () => {
    vi.useFakeTimers();
    proxyAwareFetch
      .mockResolvedValueOnce(Response.json({ upload_url: "https://upload.test/a" }))
      .mockResolvedValueOnce(Response.json({ id: "t1" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad key" }), { status: 401 }));
    const pending = handleSttCore({
      provider: "assemblyai", model: "universal", formData: formWith(smallFile()),
      credentials: { apiKey: "k" },
      sttConfig: { format: "assemblyai", baseUrl: "https://api.assemblyai.com/v2/transcript", authHeader: "authorization" },
    });
    await vi.advanceTimersByTimeAsync(2500);
    const result = await pending;
    expect(result).toMatchObject({ success: false, status: 401 });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("5xx on poll is still retried", async () => {
    vi.useFakeTimers();
    proxyAwareFetch
      .mockResolvedValueOnce(Response.json({ upload_url: "https://upload.test/a" }))
      .mockResolvedValueOnce(Response.json({ id: "t1" }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "completed", text: "done" }));
    const pending = handleSttCore({
      provider: "assemblyai", model: "universal", formData: formWith(smallFile()),
      credentials: { apiKey: "k" },
      sttConfig: { format: "assemblyai", baseUrl: "https://api.assemblyai.com/v2/transcript", authHeader: "authorization" },
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
  });
});

describe("upload size cap (H58)", () => {
  it("oversize file → 413 before buffering", async () => {
    const arrayBuffer = vi.fn();
    const huge = { size: 100 * 1024 * 1024 + 1, name: "big.wav", type: "audio/wav", arrayBuffer };
    const result = await handleSttCore({
      provider: "deepgram", model: "nova", formData: formWith(huge),
      credentials: { apiKey: "k" },
      sttConfig: { format: "deepgram", baseUrl: "https://api.deepgram.com/v1/listen", authHeader: "token" },
    });
    expect(result).toMatchObject({ success: false, status: 413 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("gemini STT key encoding (H59)", () => {
  it("URL-encodes the API key in the query string", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }));
    const result = await handleSttCore({
      provider: "gemini", model: "gemini-2.5-flash", formData: formWith(smallFile()),
      credentials: { apiKey: "a b+c/d" },
      sttConfig: { format: "gemini-stt", baseUrl: "https://generativelanguage.googleapis.com/v1beta/models", authType: "apikey" },
    });
    expect(result.success).toBe(true);
    expect(String(proxyAwareFetch.mock.calls[0][0])).toContain("key=a%20b%2Bc%2Fd");
  });
});
