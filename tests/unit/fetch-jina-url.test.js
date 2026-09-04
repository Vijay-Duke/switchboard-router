// H62 — jina-reader target must keep the raw scheme (no whole-URL encoding).
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("jina-reader target URL (H62)", () => {
  it("appends the raw http(s) URL as the path", async () => {
    const fetchMock = vi.fn(async () => new Response("# Title\n\nbody", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleFetchCore({ url: "https://example.com/a?b=c", provider: "jina-reader", providerConfig: { timeoutMs: 5000 } });
    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://r.jina.ai/https://example.com/a?b=c");
    expect(result.data.title).toBe("Title");
  });

  it("rejects non-http(s) targets with 400", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleFetchCore({ url: "ftp://example.com/a", provider: "jina-reader", providerConfig: {} });
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
