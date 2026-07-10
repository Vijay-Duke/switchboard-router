import { describe, expect, it } from "vitest";
import { createBypassRequest } from "../../open-sse/utils/proxyFetch.js";

describe("MITM DNS-bypass request cancellation", () => {
  it("rejects immediately with AbortError when the caller is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createBypassRequest(
      new URL("https://example.com/v1/test"),
      "127.0.0.1",
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
