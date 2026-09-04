// H48/H49/H50 — openrouter/openai model-voice parsing, edge-tts SSML escaping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { escapeSsml } from "../../open-sse/handlers/ttsProviders/edgeTts.js";

const audio = () => new Response(new Uint8Array(4096), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
const openrouterSse = () => new Response(
  'data: {"choices":[{"delta":{"audio":{"data":"QUJD"}}}]}\n\ndata: [DONE]\n\n',
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);
const sentBody = () => JSON.parse(proxyAwareFetch.mock.calls[0][1].body);

beforeEach(() => { proxyAwareFetch.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("openrouter model/voice parsing (H48)", () => {
  it.each([
    ["gpt-4o-mini-tts/alloy", "gpt-4o-mini-tts", "alloy"],
    ["openai/gpt-4o-mini-tts/nova", "openai/gpt-4o-mini-tts", "nova"],
  ])("%s → model %s, voice %s", async (model, expectedModel, expectedVoice) => {
    proxyAwareFetch.mockResolvedValueOnce(openrouterSse());
    const result = await handleTtsCore({ provider: "openrouter", model, input: "hi", credentials: { apiKey: "k" }, responseFormat: "json" });
    expect(result.success).toBe(true);
    expect(sentBody()).toMatchObject({ model: expectedModel, audio: { voice: expectedVoice } });
  });
});

describe("openai model/voice parsing (H50)", () => {
  it.each([
    ["tts-1/nova", "tts-1", "nova"],
    ["nova", "gpt-4o-mini-tts", "nova"],
    ["a/b/c", "a/b", "c"],
    [undefined, "gpt-4o-mini-tts", "alloy"],
  ])("%s → model %s, voice %s", async (model, expectedModel, expectedVoice) => {
    proxyAwareFetch.mockResolvedValueOnce(audio());
    const result = await handleTtsCore({ provider: "openai", model, input: "hi", credentials: { apiKey: "k" }, responseFormat: "json" });
    expect(result.success).toBe(true);
    expect(sentBody()).toMatchObject({ model: expectedModel, voice: expectedVoice });
  });
});

describe("edge-tts SSML escaping (H49)", () => {
  it("escapes markup in text and voice before interpolation", async () => {
    expect(escapeSsml(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");

    let synthInit;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("bing.com/translator")) {
        return new Response('var params_AbusePreventionHelper = [123,"tok",3600];', { status: 200 });
      }
      synthInit = init;
      return audio();
    }));

    const result = await handleTtsCore({
      provider: "edge-tts", model: "en-US-AriaNeural", input: `Tom & Jerry <break/> say "hi"`, credentials: null, responseFormat: "json",
    });
    expect(result.success).toBe(true);
    const ssml = new URLSearchParams(synthInit.body).get("ssml");
    expect(ssml).toContain("Tom &amp; Jerry &lt;break/&gt; say &quot;hi&quot;");
    expect(ssml).not.toContain("<break/>");
  });
});
