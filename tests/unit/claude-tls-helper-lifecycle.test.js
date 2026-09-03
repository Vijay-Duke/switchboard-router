import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  __drainClaudeCodeHelperPoolForTests,
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
    for (const handle of [this, this.stdin, this.stdout, this.stderr]) {
      handle.refd = true;
      handle.ref = () => { handle.refd = true; };
      handle.unref = () => { handle.refd = false; };
    }
  }

  refState() {
    return [this, this.stdin, this.stdout, this.stderr].map((handle) => handle.refd);
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
  let handed = false;
  __setClaudeCodeSpawnForTest(() => {
    // First spawn is the fetch under test; later ones are pool refills.
    if (handed) return new FakeChild();
    handed = true;
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
  __drainClaudeCodeHelperPoolForTests();
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

describe("Claude TLS helper pre-spawn pool", () => {
  const POOL_URL = "https://api.anthropic.com/v1/messages";
  const POOL_TRANSPORT = { alpn: ["http/1.1"] };
  const POOL_CAP = 2;

  // Counting fake: every spawn returns a DISTINCT child (unlike installChild
  // above), so spawn counts prove pool reuse.
  function installCountingSpawn() {
    const list = [];
    __setClaudeCodeSpawnForTest(() => {
      const child = new FakeChild();
      list.push(child);
      return child;
    });
    return { list };
  }

  const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));
  const serving = (child) => child.stdout.listenerCount("data") > 0;

  // Waits for a fetch to take a child. Settles microtasks only (never a
  // macrotask), so a pending background refill cannot fire and skew counts.
  // Falls back to immediate flushes only for the very first fetch, whose
  // binary resolve needs real loop turns while no refill can be pending yet.
  async function acquireServing(pool, lenBefore) {
    for (let i = 0; i < 200; i++) {
      const candidate = pool.list.slice(Math.max(0, lenBefore - POOL_CAP)).find(serving);
      if (candidate) return candidate;
      if (i < 20) await Promise.resolve();
      else await flushImmediate();
    }
    throw new Error("no child took the fetch");
  }

  function respondOk(child, body) {
    child.stdout.write(`${JSON.stringify({ status: 200, headers: [] })}\n${body}`);
  }

  function finishChild(child) {
    child.stdout.end();
    child.emit("exit", 0, null);
  }

  // One fetch, served and finished, followed by the background refill so
  // the pool is warm (POOL_CAP idle children) when it returns.
  async function fetchCycle(pool, body) {
    const lenBefore = pool.list.length;
    const pending = createClaudeCodeFetch()(POOL_URL, {}, POOL_TRANSPORT);
    const child = await acquireServing(pool, lenBefore);
    respondOk(child, body);
    const response = await pending;
    finishChild(child);
    expect(await response.text()).toBe(body);
    await flushImmediate();
    await flushImmediate();
    return child;
  }

  const warmPool = (pool) => pool.list.slice(-POOL_CAP);

  it("serves a fetch from the warm pool with no new spawn, then refills one replacement", async () => {
    const pool = installCountingSpawn();
    await fetchCycle(pool, "warm");
    const baseline = pool.list.length;
    const pooled = warmPool(pool);

    const pending = createClaudeCodeFetch()(POOL_URL, {}, POOL_TRANSPORT);
    const child = await acquireServing(pool, baseline);
    expect(pooled).toContain(child);
    expect(pool.list.length).toBe(baseline);
    respondOk(child, "reused");
    const response = await pending;
    finishChild(child);
    expect(await response.text()).toBe("reused");

    await flushImmediate();
    expect(pool.list.length).toBe(baseline + 1);
  });

  it("bounds a burst to the pooled children plus one fresh spawn each, then refills to the cap once", async () => {
    const pool = installCountingSpawn();
    await fetchCycle(pool, "warm");
    const baseline = pool.list.length;

    const pending = Array.from({ length: POOL_CAP + 1 }, () => createClaudeCodeFetch()(POOL_URL, {}, POOL_TRANSPORT));
    // Microtask-only wait: the scheduled refill stays pending so the count
    // below is exact — cap children popped, exactly one spawned fresh.
    for (let i = 0; i < 200 && pool.list.length < baseline + 1; i++) await Promise.resolve();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(pool.list.length).toBe(baseline + 1);

    const children = pool.list.slice(baseline - POOL_CAP);
    expect(children.every(serving)).toBe(true);
    children.forEach((child, index) => respondOk(child, `burst-${index}`));
    const responses = await Promise.all(pending);
    children.forEach(finishChild);
    const texts = await Promise.all(responses.map((response) => response.text()));
    expect([...texts].sort()).toEqual(["burst-0", "burst-1", "burst-2"]);

    // Three fetches scheduled refills, but they coalesce into one top-up.
    await flushImmediate();
    await flushImmediate();
    expect(pool.list.length).toBe(baseline + 1 + POOL_CAP);
    expect(warmPool(pool).some(serving)).toBe(false);
  });

  it("unrefs idle children and their stdio, and refs them again when taken", async () => {
    const pool = installCountingSpawn();
    await fetchCycle(pool, "warm");
    for (const child of warmPool(pool)) expect(child.refState()).toEqual([false, false, false, false]);

    const pending = createClaudeCodeFetch()(POOL_URL, {}, POOL_TRANSPORT);
    const child = await acquireServing(pool, pool.list.length);
    expect(child.refState()).toEqual([true, true, true, true]);
    respondOk(child, "ok");
    finishChild(child);
    await (await pending).text();
  });

  it("drops a pooled child that exits or errors while idle instead of handing it out", async () => {
    const pool = installCountingSpawn();
    await fetchCycle(pool, "warm");
    const baseline = pool.list.length;
    const [crashed, errored] = warmPool(pool);

    crashed.exitCode = 1;
    crashed.emit("exit", 1, null);
    // No listener would make this an uncaught 'error' event.
    expect(() => errored.emit("error", new Error("spawn EACCES"))).not.toThrow();

    const pending = createClaudeCodeFetch()(POOL_URL, {}, POOL_TRANSPORT);
    const child = await acquireServing(pool, baseline);
    expect(child).not.toBe(crashed);
    expect(child).not.toBe(errored);
    expect(pool.list.length).toBe(baseline + 1);
    expect(crashed.killed).toBe(false);
    expect(errored.killed).toBe(false);
    respondOk(child, "fresh");
    finishChild(child);
    expect(await (await pending).text()).toBe("fresh");
  });

  it("kills pooled idle children on drain and spawns fresh afterwards", async () => {
    const pool = installCountingSpawn();
    await fetchCycle(pool, "warm");
    const pooled = warmPool(pool);
    expect(pooled).toHaveLength(POOL_CAP);
    expect(pooled.some((child) => child.killed)).toBe(false);

    __drainClaudeCodeHelperPoolForTests();
    for (const child of pooled) {
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    }

    const countAfterDrain = pool.list.length;
    await flushImmediate();
    await flushImmediate();
    expect(pool.list.length).toBe(countAfterDrain);

    await fetchCycle(pool, "after-drain");
  });
});
