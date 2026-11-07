import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

beforeEach(() => proxyAwareFetch.mockReset());

describe("Antigravity web search via Google Search grounding", () => {
  it("reports a missing projectId before calling upstream", async () => {
    const result = await handleChatSearch({ provider: "antigravity", query: "q", credentials: { accessToken: "t" } });
    expect(result).toMatchObject({ success: false, status: 401 });
    expect(result.error).toMatch(/projectId/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("sends a v1internal search envelope and merges citations by URL", async () => {
    const text = "Alpha is first. Beta is second.";
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      response: {
        candidates: [{
          content: { parts: [{ text }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://a.example", title: "A" } },
              { web: { uri: "https://a.example", title: "A" } },
              { web: { uri: "https://b.example", title: "B" } },
            ],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 15, text: "Alpha is first." }, groundingChunkIndices: [0] },
              { segment: { startIndex: 16, endIndex: 31, text: "Beta is second." }, groundingChunkIndices: [1, 2] },
            ],
          },
        }],
        usageMetadata: { totalTokenCount: 42 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await handleChatSearch({
      provider: "antigravity",
      query: "letters",
      credentials: { accessToken: "tok", projectId: "proj-1" },
    });

    expect(result.success).toBe(true);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(init.identity).toBe("antigravity");
    expect(init.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ project: "proj-1", model: "gemini-2.5-flash", requestType: "search" });
    expect(body.request.tools).toEqual([{ googleSearch: {} }]);

    const { results, answer, usage } = result.data;
    expect(answer.text).toBe(text);
    expect(usage.llm_tokens).toBe(42);
    expect(results.map((r) => r.url)).toEqual(["https://a.example", "https://b.example"]);
    expect(results[0].snippet).toBe("Alpha is first. | Beta is second.");
    expect(results[1].snippet).toBe("Beta is second.");
    expect(results[1].content).toBeTruthy();
  });
});
