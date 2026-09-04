import { describe, it, expect } from "vitest";

import { classifyCursorError } from "../../open-sse/executors/cursor.js";

// NOTE: the decoded-error branches this classifier serves are currently
// unreachable — extractTextFromResponse always returns error:null and JSON
// error frames go through createErrorResponse (already correct). These tests
// pin the classifier itself so a future extractor change cannot reintroduce
// unconditional-429 misclassification of auth/ToS/ban errors.
describe("cursor error classification (E4)", () => {
  it("maps rate/quota/throttle signals to 429", () => {
    for (const msg of [
      "resource_exhausted: quota",
      "Rate limited: too many requests",
      "usage quota exceeded for this account",
      "request was throttled",
      "server overloaded, retry later",
      "HTTP 429 from upstream",
    ]) {
      const c = classifyCursorError(msg);
      expect(c.status).toBe(429);
      expect(c.type).toBe("rate_limit_error");
      expect(c.code).toBe("rate_limited");
    }
  });

  it("maps auth/ToS/ban errors to 400 (fail fast, no bogus cooldown)", () => {
    for (const msg of [
      "unauthorized: invalid token",
      "account banned for ToS violation",
      "forbidden: workspace disabled",
      "malformed request payload",
      "",
      null,
    ]) {
      const c = classifyCursorError(msg);
      expect(c.status).toBe(400);
      expect(c.type).toBe("api_error");
    }
  });
});
