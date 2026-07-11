import { describe, expect, it, vi } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

describe("compact combo fallback", () => {
  it("tries the next model after a retryable 429", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider/a", "provider/b"],
      handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
  });
});
