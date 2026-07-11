import { describe, expect, it } from "vitest";

import { extractApiKey } from "../../src/sse/services/auth.js";

describe("gateway API-key header extraction", () => {
  it("accepts Gemini's x-goog-api-key header", () => {
    const request = new Request("http://localhost/v1beta/models/gemini-pro:generateContent", {
      headers: { "x-goog-api-key": "sk-gemini" },
    });

    expect(extractApiKey(request)).toBe("sk-gemini");
  });
});
