// Qwen device-code token polling must survive HTML error pages from the
// alibaba-ga gateway (504 text/html) instead of throwing "Unexpected token '<'".
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

import { pollForToken } from "../../src/lib/oauth/providers.js";

afterEach(() => mocks.proxyAwareFetch.mockReset());

const htmlGatewayTimeout = () => new Response(
  "<html><head><title>504 Gateway Time-out</title></head></html>",
  { status: 504, headers: { "content-type": "text/html" } },
);

describe("qwen device-code pollToken resilience", () => {
  it("keeps polling (pending) when the token endpoint answers an HTML 504", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(htmlGatewayTimeout());

    const result = await pollForToken("qwen", "device-code", "verifier");

    // The route maps error === "authorization_pending" to a pending poll.
    expect(result).toMatchObject({ success: false, error: "authorization_pending" });
  });

  it("reports a clean error for a non-JSON 4xx (no JSON parse throw)", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response("Bad Request", { status: 400 }));

    const result = await pollForToken("qwen", "device-code", "verifier");

    expect(result.success).toBe(false);
    expect(result.error).toBe("token_endpoint_http_400");
  });

  it("still parses a real JSON authorization_pending response", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response(
      JSON.stringify({ error: "authorization_pending" }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    const result = await pollForToken("qwen", "device-code", "verifier");

    expect(result).toMatchObject({ success: false, error: "authorization_pending" });
  });
});
