import { describe, expect, it, vi } from "vitest";

import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";

describe("disconnect-aware stream cancel (H64)", () => {
  it("cancelling after the other end already settled raises no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const transform = new TransformStream();
      const streamController = { isConnected: () => true, handleDisconnect: vi.fn(), handleComplete: vi.fn(), handleError: vi.fn() };
      const stream = createDisconnectAwareStream(transform, streamController);

      await stream.cancel("client gone");
      // A second cancel hits an already-released reader/aborted writer.
      await expect(stream.cancel("again")).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(streamController.handleDisconnect).toHaveBeenCalledWith("client gone");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
