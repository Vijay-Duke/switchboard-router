// Rate-limit headers reach the client so it can back off on the upstream's
// real window. (ported from upstream dc198dff)
import { describe, it, expect } from "vitest";
import { upstreamResponseHeaders } from "../../open-sse/utils/upstreamHeaders.js";
import { createErrorResult, unavailableResponse } from "../../open-sse/utils/error.js";

const upstream = new Headers({
  "anthropic-ratelimit-requests-remaining": "0",
  "anthropic-ratelimit-tokens-reset": "2026-11-07T23:00:00Z",
  "retry-after": "12",
  "x-should-retry": "true",
  "set-cookie": "secret=1",
  "request-id": "req_123",
});

describe("upstream rate-limit header forwarding", () => {
  it("keeps only rate-limit and retry signals", () => {
    expect(upstreamResponseHeaders(upstream)).toEqual({
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-tokens-reset": "2026-11-07T23:00:00Z",
      "retry-after": "12",
      "x-should-retry": "true",
    });
    expect(upstreamResponseHeaders(null)).toEqual({});
  });

  it("attaches them to error results without adding CORS", () => {
    const { response } = createErrorResult(429, "slow down", undefined, undefined, upstreamResponseHeaders(upstream));
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("0");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("unavailableResponse keeps its own Retry-After over a forwarded one", () => {
    const res = unavailableResponse(503, "busy", new Date(Date.now() + 60_000).toISOString(), "reset after 60s", upstreamResponseHeaders(upstream));
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(50);
    expect(res.headers.get("anthropic-ratelimit-tokens-reset")).toBe("2026-11-07T23:00:00Z");
  });
});
