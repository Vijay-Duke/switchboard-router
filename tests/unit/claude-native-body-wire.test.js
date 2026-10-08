import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../open-sse/runtimeDeps.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/usageTracking.js", async importOriginal => ({
  ...await importOriginal(), logUsage: vi.fn(),
}));
const require = createRequire(import.meta.url);
const { pipeToNodeResponse } = require("next/dist/server/pipe-readable.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { createClaudeCodeFetch, __setClaudeCodeSpawnForTest } = await import("../../open-sse/identity/tls/claude-code.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const nativeDir = fileURLToPath(new URL("../../open-sse/identity/tls/native/", import.meta.url));
let directory, helper;
const children = new Set();
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-sse-wire-"));
  helper = path.join(directory, process.platform === "win32" ? "helper.test.exe" : "helper.test");
  const built = spawnSync("go", ["test", "-c", "-o", helper, "."], { cwd: nativeDir, encoding: "utf8", timeout: 120000 });
  expect(built.error, built.stderr).toBeUndefined();
  expect(built.status, built.stderr).toBe(0);
}, 120000);
afterEach(async () => {
  __setClaudeCodeSpawnForTest();
  await Promise.all([...children].map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    return new Promise(resolve => child.once("exit", resolve));
  }));
  children.clear();
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn() };
const controller = () => createStreamController({ provider: "claude", model: "synthetic", log });
const noop = vi.fn();
async function streaming(providerResponse) {
  const result = await handleStreamingResponse({
    providerResponse, provider: "claude", model: "synthetic", body: { stream: true },
    sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.CLAUDE,
    streamController: controller(), log,
    reqLogger: { logProviderResponse: noop, logConvertedResponse: noop },
    requestStartTime: Date.now(), appendLog: noop,
  });
  return result.response;
}
async function httpWire(makeResponse) {
  let bridgeError;
  const server = http.createServer(async (_request, response) => {
    try {
      const streamed = await streaming(await makeResponse());
      response.statusCode = streamed.status;
      for (const [name, value] of streamed.headers) response.setHeader(name, value);
      await pipeToNodeResponse(streamed.body, response);
    } catch (error) { bridgeError = error; response.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const returned = await new Promise(resolve => {
      const request = http.get({ hostname: "127.0.0.1", port: server.address().port }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
        response.on("error", error => resolve({ error }));
      });
      request.setTimeout(2000, () => request.destroy(new Error("offline response fixture timed out")));
      request.on("error", error => resolve({ error }));
    });
    return { ...returned, bridgeError };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
describe("Claude transport through actual Next Node HTTP response pipe", () => {
  it.each([false, true])("delivers delayed SSE after the native setup deadline (gzip=%s)", async gzip => {
    __setClaudeCodeSpawnForTest((_binary, args, opts) => {
      const child = spawn(helper, args, {
        ...opts, env: { ...process.env, SWITCHBOARD_TEST_SSE_BODY_BRIDGE: "1", SWITCHBOARD_TEST_SSE_GZIP: gzip ? "1" : "0" },
      });
      children.add(child);
      return child;
    });
    const returned = await httpWire(() => createClaudeCodeFetch()(
      "https://synthetic.invalid/messages", { timeoutMs: 50 }, { alpn: ["http/1.1"] },
    ));
    expect(returned.error).toBeUndefined();
    expect(returned.bridgeError).toBeUndefined();
    expect(returned.status).toBe(200);
    expect(returned.body).toContain("event: message_start");
    expect(returned.body).toContain("event: message_stop");
    expect(returned.body).not.toContain("event: error");
  });
  it("emits a Claude error if upstream body fails before the first SSE bytes", async () => {
    const returned = await httpWire(async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => controller.error(new Error("Claude TLS helper response body failed: i/o timeout")), 10);
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect(returned.error).toBeUndefined();
    expect(returned.bridgeError).toBeUndefined();
    expect(returned.status).toBe(200);
    expect(returned.body).toMatch(/^event: error\ndata: /);
    const events = returned.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(returned.body).not.toMatch(/message_stop|end_turn|input_json_delta|\[DONE\]/);
  });
});
