import { describe, expect, it } from "vitest";

import { parseUpstreamError } from "../../open-sse/utils/error.js";

describe("parseUpstreamError safety", () => {
  it("caps oversized upstream error bodies", async () => {
    const result = await parseUpstreamError(new Response("x".repeat(100_000), { status: 502 }));

    expect(result.message.length).toBeLessThanOrEqual(65_536);
  });

  it("does not echo arbitrary fields from structured upstream errors", async () => {
    const result = await parseUpstreamError(new Response(JSON.stringify({
      error: { api_key: "super-secret-value", code: "private-code" },
    }), { status: 401 }));

    expect(result.message).toBe("Invalid API key provided");
    expect(result.message).not.toContain("super-secret-value");
    expect(result.message).not.toContain("private-code");
  });
});
