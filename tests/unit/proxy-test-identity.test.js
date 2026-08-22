import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  fetch: vi.fn(),
  ProxyAgent: vi.fn(function ProxyAgent(options) {
    this.options = options;
    this.close = mocks.close;
  }),
}));

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
  fetch: mocks.fetch,
}));

import { testProxyUrl } from "../../src/lib/network/proxyTest.js";

describe("external proxy connectivity test identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
    });
  });

  it("leaves User-Agent selection to undici", async () => {
    await testProxyUrl({
      proxyUrl: "http://proxy.example:8080",
      testUrl: "https://example.com/health",
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    const headers = new Headers(init.headers);

    expect(url).toBe("https://example.com/health");
    expect(init.method).toBe("HEAD");
    expect(init.dispatcher).toBe(mocks.ProxyAgent.mock.instances[0]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headers.has("user-agent")).toBe(false);
    expect(JSON.stringify(init)).not.toMatch(/switchboard/i);
  });
});
