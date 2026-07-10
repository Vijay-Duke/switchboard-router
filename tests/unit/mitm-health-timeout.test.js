import { describe, it, expect } from "vitest";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pollMitmHealth } = require("../../src/mitm/manager.js");

/**
 * Regression: pollMitmHealth() issued an https.request with no socket timeout.
 * A server that accepts the TCP connection but never completes TLS fires
 * neither `response` nor `error`, so the promise never settled and MITM
 * startup hung forever instead of reporting failure.
 *
 * A bare TCP listener reproduces that exactly: the TLS handshake stalls.
 */
describe("pollMitmHealth", () => {
  it("resolves null against a server that accepts but never responds", async () => {
    const sockets = [];
    const server = net.createServer((sock) => sockets.push(sock)); // never reply
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();

    try {
      const started = Date.now();
      // Before the fix this never settles and the test times out.
      await expect(pollMitmHealth(2500, port)).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(20000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  }, 25000);
});
