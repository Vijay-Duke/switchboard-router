/**
 * Port of upstream 0648e9e4 (node:test .cjs) to vitest:
 * JetBrains Runtime 25+ sends h2c upgrades on OpenAI-compatible requests.
 * Node routes an Upgrade request through the normal HTTP/1.1 handler when no
 * "upgrade" listener exists (body intact); the custom server must scrub the
 * Upgrade/HTTP2-Settings headers and reply with Connection: close. The emit
 * hook in custom-server.js covers the listener-forced upgrade path as a
 * fallback, so the test deliberately registers none (that path loses
 * post-upgrade body bytes on node v18+).
 */

import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("custom-server h2c downgrade", () => {
  it("serves h2c POST requests as HTTP/1.1", async () => {
    const originalCreateServer = http.createServer;
    delete require.cache[require.resolve("../../custom-server.js")];
    require("../../custom-server.js");

    const server = http.createServer(async (req, res) => {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers.upgrade).toBeUndefined();
      expect(req.headers["http2-settings"]).toBeUndefined();
      expect(req.headers.connection).toBe("close");
      const body = [];
      for await (const chunk of req) body.push(chunk);
      expect(Buffer.concat(body).toString("utf8")).toBe('{"model":"test","stream":true}');
      res.setHeader("Content-Type", "text/event-stream");
      res.end("data: [DONE]\n\n");
    });


    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = server.address().port;

      const response = await new Promise((resolve, reject) => {
        const chunks = [];
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          const body = '{"model":"test","stream":true}';
          socket.write([
            "POST /v1/chat/completions HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade, HTTP2-Settings",
            "Upgrade: h2c",
            "HTTP2-Settings: AAEAAEAAAAIAAAAAAAMAAAAAAAQBAAAAAAUAAEAAAAYABgAA",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Content-Type: application/json",
            "",
            "",
          ].join("\r\n"));
          setImmediate(() => socket.write(body));
        });
        socket.setTimeout(2_000, () => {
          socket.destroy();
          reject(new Error("h2c fallback response timed out"));
        });
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });

      expect(response).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      expect(response).toMatch(/\r\nContent-Type: text\/event-stream\r\n/i);
      expect(response).toMatch(/\r\nConnection: close\r\n/i);
      expect(response).toMatch(/\r\n\r\ndata: \[DONE\]\n\n$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      http.createServer = originalCreateServer;
    }
  });
});
