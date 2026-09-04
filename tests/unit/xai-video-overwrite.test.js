import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { run } = require("../../cli/src/cli/commands/xaiVideo.js");

const MP4_BYTES = Buffer.from("FAKE-MP4-DATA");

let tmpDir;
let server;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xai-video-overwrite-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function startGateway() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/v1/videos/generations") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ request_id: "job-1" }));
        return;
      }
      if (req.url === "/v1/videos/job-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "done", video: { url: `http://127.0.0.1:${server.address().port}/v.mp4` } }));
        return;
      }
      if (req.url === "/v.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end("NEW-BYTES");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

describe("xaiVideo output overwrite guard (L6)", () => {
  it("refuses to overwrite an existing file without --force", async () => {
    const port = await startGateway();
    const output = path.join(tmpDir, "existing.mp4");
    fs.writeFileSync(output, "ORIGINAL");

    const code = await run(["--prompt", "hi", "--output", output, "--port", String(port)]);
    expect(code).toBe(1);
    expect(fs.readFileSync(output, "utf8")).toBe("ORIGINAL");
  });

  it("overwrites with --force", async () => {
    const port = await startGateway();
    const output = path.join(tmpDir, "existing.mp4");
    fs.writeFileSync(output, "ORIGINAL");

    const code = await run(["--prompt", "hi", "--output", output, "--port", String(port), "--force"]);
    expect(code).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe("NEW-BYTES");
    expect(MP4_BYTES.length).toBeGreaterThan(0);
  });
});
