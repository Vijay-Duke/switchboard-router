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

it("rejects a provider-owned thread delta rather than returning a false local token estimate", async () => {
  const response = await POST(new Request("http://localhost/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "cc/claude-opus-5-5", thread: { type: "continue", previous_message_id: "msg_prior" }, messages: [{ role: "user", content: "continue" }] }) }));
  expect(response.status).toBe(400);
  expect(await response.json()).not.toHaveProperty("input_tokens");
});
