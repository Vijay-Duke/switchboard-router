import { describe, expect, it } from "vitest";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { gatewayRequest, DEFAULT_REQUEST_TIMEOUT_SEC } = require("../../cli/src/cli/commands/xaiVideo.js");

describe("xaiVideo gateway timeout (L7)", () => {
  it("rejects a stalled gateway within the timeout budget", async () => {
    const server = http.createServer(() => { /* never respond: hang */ });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const started = Date.now();
      await expect(
        gatewayRequest({ host: "127.0.0.1", port, method: "GET", reqPath: "/v1/videos/x", timeoutMs: 300 })
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.close();
    }
  });

  it("defaults to a documented 30s timeout", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_SEC).toBe(30);
  });
});
