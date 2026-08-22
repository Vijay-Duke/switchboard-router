import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setClaudeCodeSpawnForTest,
  createClaudeCodeFetch,
} from "../../open-sse/identity/tls/claude-code.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill(signal) {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }
}

function installChild(child) {
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  __setClaudeCodeSpawnForTest(() => {
    markSpawned();
    return child;
  });
  return spawned;
}

async function outcomeWithin(promise, timeoutMs = 100) {
  return Promise.race([
    promise.then(
      (value) => ({ state: "resolved", value }),
      (error) => ({ state: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: "timeout" }), timeoutMs)),
  ]);
}

function fetchWith(signal) {
  return createClaudeCodeFetch()("https://api.anthropic.com/v1/messages", { signal }, {
    alpn: ["http/1.1"],
  });
}

afterEach(() => {
  __setClaudeCodeSpawnForTest();
});

it("sends a bounded timeout in helper metadata with init, transport, and default precedence", async () => {
  const cases = [
    { init: { timeoutMs: 1250 }, transport: { timeoutMs: 2500 }, want: 1250 },
    { init: {}, transport: { timeoutMs: 2500 }, want: 2500 },
    { init: { timeoutMs: 0 }, transport: { timeoutMs: -1 }, want: 60_000 },
  ];

  for (const { init, transport, want } of cases) {
    const child = new FakeChild();
    const spawned = installChild(child);
    const metadata = new Promise((resolve) => {
      child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8").split("\n", 1)[0])));
    });
    const response = createClaudeCodeFetch()("https://api.anthropic.com/v1/messages", init, {
      alpn: ["http/1.1"],
      ...transport,
    });
    await spawned;

    expect((await metadata).timeoutMs).toBe(want);
    child.stdout.end(`${JSON.stringify({ status: 200, headers: [] })}\n`);
    child.emit("exit", 0, null);
    await response;
  }
});

describe("Claude TLS helper lifecycle", () => {
  it("rejects with AbortError and terminates the helper when aborted before metadata", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const controller = new AbortController();
    const response = fetchWith(controller.signal);
    await spawned;

    controller.abort();

    const outcome = await outcomeWithin(response);
    expect(outcome.state).toBe("rejected");
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("rejects when the helper exits cleanly before metadata", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const response = fetchWith();
    await spawned;

    child.emit("exit", 0, null);

    const outcome = await outcomeWithin(response);
    expect(outcome.state).toBe("rejected");
    expect(outcome.error.message).toMatch(/exited.*before.*metadata/i);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("rejects when the helper is terminated before metadata", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const response = fetchWith();
    await spawned;

    child.emit("exit", null, "SIGTERM");

    const outcome = await outcomeWithin(response);
    expect(outcome.state).toBe("rejected");
    expect(outcome.error.message).toMatch(/exited.*before.*metadata.*SIGTERM/i);
  });

  it("streams response bytes and closes normally after a complete helper response", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const responsePromise = fetchWith();
    await spawned;

    child.stdout.write(`${JSON.stringify({
      status: 201,
      statusText: "Created",
      headers: [["content-type", "text/plain"], ["x-helper", "ok"]],
    })}\nhello`);
    const response = await responsePromise;
    child.stdout.end(" world");
    child.emit("exit", 0, null);

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-helper")).toBe("ok");
    expect(await response.text()).toBe("hello world");
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
  it("errors the response body when the helper fails after partial output", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const responsePromise = fetchWith();
    await spawned;

    child.stdout.write(`${JSON.stringify({ status: 200, headers: [] })}\npartial`);
    const response = await responsePromise;
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");

    child.stderr.end("response body copy failed: read timed out\n");
    child.emit("exit", 1, null);

    const outcome = await outcomeWithin(reader.read());
    expect(outcome.state).toBe("rejected");
    expect(outcome.error.message).toMatch(/response body copy failed: read timed out/i);
  });

  it("rejects response.text when stdout ends before a failed helper exit", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const responsePromise = fetchWith();
    await spawned;

    child.stdout.end(`${JSON.stringify({ status: 200, headers: [] })}\npartial`);
    const response = await responsePromise;
    const text = response.text();
    child.stderr.end("Claude TLS helper response body failed: unexpected EOF\n");
    child.emit("exit", 1, null);

    const outcome = await outcomeWithin(text);
    expect(outcome.state).toBe("rejected");
    expect(outcome.error.message).toMatch(/response body failed: unexpected EOF/i);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });


  it("errors the response body with AbortError when aborted mid-stream", async () => {
    const child = new FakeChild();
    const spawned = installChild(child);
    const controller = new AbortController();
    const responsePromise = fetchWith(controller.signal);
    await spawned;

    child.stdout.write(`${JSON.stringify({ status: 200, headers: [] })}\nfirst`);
    const response = await responsePromise;
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

    controller.abort();

    const outcome = await outcomeWithin(reader.read());
    expect(outcome.state).toBe("rejected");
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
});
