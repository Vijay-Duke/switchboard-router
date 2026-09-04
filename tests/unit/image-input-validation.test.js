// H37/H38/H39/H40/H44/H45 — image core input validation, refreshed poll headers,
// redirect:"error", n/prompt caps, fal/gemini normalize edge cases.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const refreshWithRetry = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: vi.fn() }));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { POLL_INTERVAL_MS } from "../../open-sse/handlers/imageProviders/_base.js";
import falAi from "../../open-sse/handlers/imageProviders/falAi.js";
import geminiImage from "../../open-sse/handlers/imageProviders/gemini.js";
import antigravity from "../../open-sse/handlers/imageProviders/antigravity.js";

const openaiOk = () => new Response(JSON.stringify({ created: 1, data: [{ url: "https://x/y.png" }] }), {
  status: 200, headers: { "Content-Type": "application/json" },
});
const run = (body, extra = {}) => handleImageGenerationCore({
  body, modelInfo: { provider: "openai", model: "dall-e-3" }, credentials: { apiKey: "k" }, log: null, ...extra,
});

beforeEach(() => {
  proxyAwareFetch.mockReset();
  refreshWithRetry.mockReset().mockResolvedValue(null);
  getExecutor.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("image input validation (H37/H40)", () => {
  it("numeric prompt → 400, no upstream call", async () => {
    const result = await run({ prompt: 12345 });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("whitespace-only prompt → 400", async () => {
    const result = await run({ prompt: "   " });
    expect(result).toMatchObject({ success: false, status: 400 });
  });

  it("prompt over 32k chars → 400", async () => {
    const result = await run({ prompt: "a".repeat(32 * 1024 + 1) });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toMatch(/exceeds/);
  });

  it("n is clamped to the provider max before forwarding", async () => {
    proxyAwareFetch.mockResolvedValueOnce(openaiOk());
    const result = await run({ prompt: "cat", n: 1000 });
    expect(result.success).toBe(true);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).n).toBe(10);
  });

  it("negative / NaN n is clamped to 1", async () => {
    proxyAwareFetch.mockResolvedValueOnce(openaiOk()).mockResolvedValueOnce(openaiOk());
    await run({ prompt: "cat", n: -4 });
    await run({ prompt: "cat", n: "abc" });
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).n).toBe(1);
    expect(JSON.parse(proxyAwareFetch.mock.calls[1][1].body).n).toBe(1);
  });
});

describe("image egress (H39)", () => {
  it("never follows upstream redirects", async () => {
    proxyAwareFetch.mockResolvedValueOnce(openaiOk());
    await run({ prompt: "cat" });
    expect(proxyAwareFetch.mock.calls[0][1].redirect).toBe("error");
  });
});

describe("refreshed headers reach async polling (H38)", () => {
  it("polls with the rotated key after a 401 refresh", async () => {
    vi.useFakeTimers();
    getExecutor.mockReturnValue({ refreshCredentials: vi.fn() });
    refreshWithRetry.mockResolvedValueOnce({ apiKey: "new-key" });
    proxyAwareFetch
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 200, data: { taskId: "t1" } }))
      .mockResolvedValueOnce(Response.json({ data: { successFlag: 1, response: { resultImageUrl: "https://x/out.png" } } }));

    const pending = handleImageGenerationCore({
      body: { prompt: "cat" },
      modelInfo: { provider: "nanobanana", model: "nano-banana" },
      credentials: { apiKey: "old-key" },
      log: null,
    });
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer new-key");
    expect(proxyAwareFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer new-key");
  });
});

describe("adapter normalize edge cases (H44/H45)", () => {
  it("fal drops payload items without a url instead of forwarding objects", () => {
    const out = falAi.normalize({ images: [{ foo: 1 }, "https://a/b.png", { url: "https://c/d.png" }] });
    expect(out.data).toEqual([{ url: "https://a/b.png" }, { url: "https://c/d.png" }]);
  });

  it("gemini / antigravity return an empty set when no image parts came back", () => {
    const body = { candidates: [{ content: { parts: [{ text: "no image for you" }] } }] };
    expect(geminiImage.normalize(body, "p").data).toEqual([]);
    expect(antigravity.normalize(body, "p").data).toEqual([]);
  });
});
