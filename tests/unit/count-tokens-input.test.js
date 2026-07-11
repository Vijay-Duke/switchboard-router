import { describe, expect, it } from "vitest";

import { POST } from "../../src/app/api/v1/messages/count_tokens/route.js";

describe("count-tokens request validation", () => {
  it("returns 400 for a JSON null body", async () => {
    const response = await POST(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }));

    expect(response.status).toBe(400);
  });
});
