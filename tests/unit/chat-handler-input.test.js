import { describe, expect, it } from "vitest";

import { handleChat } from "../../src/sse/handlers/chat.js";

describe("chat request validation", () => {
  it("returns a client error for a JSON null body", async () => {
    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Invalid JSON body" } });
  });
});
