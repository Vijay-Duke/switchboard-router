import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pins: new Map(), connections: vi.fn(), set: vi.fn(), directReject: false }));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnections: state.connections }));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({
  get: async key => state.pins.get(key) || null,
  set: (...args) => state.directReject ? Promise.reject(new Error("synthetic persistence failure after disconnect")) : state.set(...args),
  getAll: async () => Object.fromEntries(state.pins), remove: async key => state.pins.delete(key),
}) }));
const context = { provider: "claude", model: "claude-opus-5-5", clientKeyId: "client_a", connectionId: "account_a" };
const delta = { thread: { type: "continue", previous_message_id: "SECRET_MESSAGE_ID" } };
const resolveArgs = { body: delta, ...context };
const encoder = new TextEncoder();
beforeEach(() => { state.pins.clear(); state.directReject = false; state.set.mockImplementation(async (key, value) => state.pins.set(key, value)); state.connections.mockResolvedValue([{ id: "account_a" }, { id: "account_b" }]); });
describe("durable native Claude thread ownership", () => {
  it("captures a split SSE message ID without changing a single byte, then pins across threadService reload", async () => {
    let threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    const text = 'event: message_start\ndata: {"type":"message_start","message":{"id":"SECRET_MESSAGE_ID"}}\n\ndata: {"type":"content_block_delta","delta":{"text":"héllo"}}\n\n';
    const bytes = encoder.encode(text);
    const response = new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } }), { headers: { "content-type": "text/event-stream", "x-upstream": "preserved" } });
    const bound = threadService.bindClaudeThreadResponse(response, context);
    expect(new Uint8Array(await bound.arrayBuffer())).toEqual(bytes);
    expect(bound.headers.get("x-upstream")).toBe("preserved");
    expect(JSON.stringify([...state.pins])).not.toContain("SECRET_MESSAGE_ID");
    vi.resetModules(); threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    expect(await threadService.resolveClaudeThreadOwner(resolveArgs)).toEqual({ connectionId: "account_a" });
    expect(state.connections).not.toHaveBeenCalled();
  });
  it("records JSON response ownership and rejects model changes and unknown ownership in multi-account pools", async () => {
    const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    const response = threadService.bindClaudeThreadResponse(Response.json({ id: "SECRET_MESSAGE_ID", content: [] }), context);
    expect(await response.json()).toEqual({ id: "SECRET_MESSAGE_ID", content: [] });
    expect(await threadService.resolveClaudeThreadOwner({ ...resolveArgs, model: "claude-sonnet-5-5" })).toHaveProperty("error");
    expect(await threadService.resolveClaudeThreadOwner({ ...resolveArgs, clientKeyId: "different-client" })).toHaveProperty("error");
  });
  it("allows legacy unrecorded threads only with exactly one active account", async () => {
    const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    expect(await threadService.resolveClaudeThreadOwner(resolveArgs)).toHaveProperty("error");
    state.connections.mockResolvedValue([{ id: "single_account" }]);
    expect(await threadService.resolveClaudeThreadOwner(resolveArgs)).toEqual({ connectionId: "single_account" });
  });
  it("does not wrap or consume provider errors", async () => {
    const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    const response = new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
    expect(threadService.bindClaudeThreadResponse(response, context)).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
});

it("pins a large native JSON response from its root ID without buffering the full content", async () => {
  const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
  const body = { id: "SECRET_MESSAGE_ID", content: [{ type: "text", text: "x".repeat(200000) }] };
  const response = threadService.bindClaudeThreadResponse(Response.json(body), context);
  expect(await response.json()).toEqual(body);
  expect(await threadService.resolveClaudeThreadOwner(resolveArgs)).toEqual({ connectionId: "account_a" });
});

it("bounds a hung ownership write instead of hanging the response", async () => {
  vi.useFakeTimers();
  try {
    state.set.mockReturnValue(new Promise(() => {}));
    const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
    const log = { warn: vi.fn() };
    const response = threadService.bindClaudeThreadResponse(Response.json({ id: "SECRET_MESSAGE_ID", content: [] }), { ...context, log });
    const read = response.json();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await read).toEqual({ id: "SECRET_MESSAGE_ID", content: [] });
    expect(log.warn).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("propagates client cancellation to the source stream", async () => {
  const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
  const cancel = vi.fn();
  const response = threadService.bindClaudeThreadResponse(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }), context);
  await response.body.cancel(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancel).toHaveBeenCalledOnce();
});

it("forwards malformed JSON ID bytes without letting the ownership observer abort the stream", async () => {
  const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
  const bytes = encoder.encode('{"id":"\\q","content":[]}');
  const response = threadService.bindClaudeThreadResponse(new Response(bytes, { headers: { "content-type": "application/json" } }), context);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(state.pins.size).toBe(0);
});

it("consumes a rejected KV operation even when the client was already aborted", async () => {
  const threadService = await import("../../src/sse/services/claudeThreadOwnership.js");
  state.directReject = true;
  const response = threadService.bindClaudeThreadResponse(Response.json({ id: "SECRET_MESSAGE_ID", content: [] }), { ...context, signal: AbortSignal.abort() });
  expect(await response.json()).toEqual({ id: "SECRET_MESSAGE_ID", content: [] });
  // An unhandled rejection here is a process-level failure caught by Vitest.
  await new Promise(resolve => setTimeout(resolve, 0));
});
