import { describe, it, expect } from "vitest";

import { GeminiCLIExecutor, retryDelayToMs } from "../../open-sse/executors/gemini-cli.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

function retryInfoBody(retryDelay) {
  return JSON.stringify({
    error: {
      code: 429,
      message: "Quota exceeded",
      details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  });
}

describe("gemini-cli RetryInfo (E2)", () => {
  it("parses string durations", () => {
    expect(retryDelayToMs("30s")).toBe(30000);
    expect(retryDelayToMs("1.5s")).toBe(1500);
    expect(retryDelayToMs("bogus")).toBeNull();
    expect(retryDelayToMs(null)).toBeNull();
  });

  it("parses Duration objects", () => {
    expect(retryDelayToMs({ seconds: "30", nanos: 0 })).toBe(30000);
    expect(retryDelayToMs({ seconds: 5, nanos: 500000000 })).toBe(5500);
  });

  it("parseError converts retryDelay to resetsAtMs", () => {
    const ex = new GeminiCLIExecutor();
    const before = Date.now();
    const parsed = ex.parseError({ status: 429 }, retryInfoBody("30s"));
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 29000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 31000);
  });

  it("parseUpstreamError forwards resetsAtMs end-to-end (cooldown/fallback sees it)", async () => {
    const ex = new GeminiCLIExecutor();
    const before = Date.now();
    const res = new Response(retryInfoBody("30s"), { status: 429 });
    const parsed = await parseUpstreamError(res, ex);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 29000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 31000);
  });

  it("leaves non-429 errors without resetsAtMs", () => {
    const ex = new GeminiCLIExecutor();
    const parsed = ex.parseError({ status: 500 }, retryInfoBody("30s"));
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});
