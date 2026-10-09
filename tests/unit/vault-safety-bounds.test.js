import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../open-sse/runtimeDeps.js", () => ({ searchVault: search }));
vi.mock("../../open-sse/rtk/vaultStats.js", () => ({ recordVaultHit: vi.fn() }));
import { classifyResponse, runVaultLoop, repairInboundVaultResults, MAX_VAULT_LOOP_MS, MAX_VAULT_INTERNAL_MS, MAX_VAULT_BUFFER_BYTES, VAULT_SEARCH_TIMEOUT_MS } from "../../open-sse/rtk/vaultLoop.js";
const tool = (id = "call_a", input = { query: "needle" }) => ({ type: "tool_use", id, name: "sb_vault_search", input });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const claudeCall = () => Response.json({ content: [tool()] });
beforeEach(() => { search.mockReset().mockResolvedValue([{ text: "actual recovered result" }]); });
afterEach(() => vi.useRealTimers());
describe("vault safety bounds and faithful tool arguments", () => {
  it("does not execute complete-looking calls from a truncated stream", async () => {
    const wires = {
      claude: frame({ type: "content_block_start", index: 0, content_block: tool() }),
      openai: frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "sb_vault_search", arguments: '{"query":"needle"}' } }] } }] }),
    };
    for (const [wire, raw] of Object.entries(wires)) {
      const result = await classifyResponse(sse(raw), wire);
      expect(result.kind).not.toBe("call");
      expect(await result.replay.text()).toBe(raw);
    }
    expect(search).not.toHaveBeenCalled();
  });
  it("forwards malformed JSON arguments and non-string queries without inventing an input", async () => {
    for (const [wire, response] of [
      ["openai", Response.json({ choices: [{ message: { tool_calls: [{ id: "a", function: { name: "sb_vault_search", arguments: '{"query":' } }] } }] })],
      ["claude", Response.json({ content: [tool("a", { query: { unsafe: "object" } })] })],
      ["claude", sse(frame({ type: "content_block_start", index: 0, content_block: { ...tool(), input: {} } }) + frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":' } }) + frame({ type: "message_stop" }))],
    ]) {
      const original = await response.clone().text();
      const result = await classifyResponse(response, wire);
      expect(result.kind).not.toBe("call");
      expect(await result.replay.text()).toBe(original);
    }
    expect(search).not.toHaveBeenCalled();
  });
  it("forwards error statuses, truncated JSON, reasoning and duplicate IDs unchanged", async () => {
    const openai = { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "sb_vault_search", arguments: '{"query":"x"}' } }] } }] };
    for (const [wire, response] of [
      ["claude", Response.json({ content: [tool()] }, { status: 502 })],
      ["claude", Response.json({ content: [tool()], stop_reason: "max_tokens" })],
      ["claude", Response.json({ content: [tool("a"), tool("a")] })],
      ["openai", Response.json({ choices: [{ ...openai.choices[0], finish_reason: "length" }] })],
      ["openai", Response.json({ choices: [{ message: { ...openai.choices[0].message, reasoning_content: "signed reasoning" } }] })],
    ]) {
      const original = await response.clone().text();
      const status = response.status;
      const result = await classifyResponse(response, wire);
      expect(result.kind).not.toBe("call");
      expect(result.replay.status).toBe(status);
      expect(await result.replay.text()).toBe(original);
    }
  });
  it("preserves provider 429 status and retry delay without buffering a stalled body", async () => {
    const response = new Response(new ReadableStream({ start() {} }), { status: 429, headers: { "retry-after": "3600" } });
    const result = await classifyResponse(response, "claude");
    expect(result.replay).toBe(response);
    expect(result.replay.status).toBe(429);
    expect(result.replay.headers.get("retry-after")).toBe("3600");
    await result.replay.body.cancel();
  });
  it("does not retry an initial thrown provider dispatch beneath the client", async () => {
    const dispatch = vi.fn(async () => { throw new Error("provider failed"); });
    const response = await runVaultLoop({ dispatch, body: { messages: [] }, wire: "claude", conversationId: "c" });
    expect(response.status).toBe(502);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("replays fully received invalid UTF-8 bytes instead of replacing them with an error", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
    const result = await classifyResponse(new Response(bytes, { headers: { "content-type": "application/json" } }), "openai");
    expect(result.kind).toBe("none");
    expect(result.replay.status).toBe(200);
    expect(new Uint8Array(await result.replay.arrayBuffer())).toEqual(bytes);
  });
  it("accepts empty standard OpenAI response metadata without losing actual refusal or annotations", async () => {
    const message = { role: "assistant", content: null, refusal: null, annotations: [], tool_calls: [{ id: "a", function: { name: "sb_vault_search", arguments: '{"query":"x"}' } }] };
    expect((await classifyResponse(Response.json({ choices: [{ message }] }), "openai")).kind).toBe("call");
    for (const extra of [{ refusal: "refused" }, { annotations: [{ type: "citation" }] }]) {
      expect((await classifyResponse(Response.json({ choices: [{ message: { ...message, ...extra } }] }), "openai")).kind).toBe("mixed");
    }
  });
  it("preserves distinct parallel OpenAI calls when indexes are omitted", async () => {
    const raw = ["a", "b"].map(id => frame({ choices: [{ delta: { tool_calls: [{ id, function: { name: "sb_vault_search", arguments: JSON.stringify({ query: id }) } }] } }] })).join("") + "data: [DONE]\n\n";
    const result = await classifyResponse(sse(raw), "openai");
    expect(result.kind).toBe("call");
    expect(result.calls.map(x => [x.callId, x.query])).toEqual([["a", "a"], ["b", "b"]]);
  });
  it("forwards OpenAI reasoning or error frames unchanged", async () => {
    const call = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "sb_vault_search", arguments: '{"query":"x"}' } }] } }] });
    for (const extra of [{ choices: [{ delta: { reasoning_content: "required reasoning" } }] }, { error: { message: "provider failed" } }]) {
      const raw = call + frame(extra) + "data: [DONE]\n\n";
      const result = await classifyResponse(sse(raw), "openai");
      expect(result.kind).toBe("mixed");
      expect(await result.replay.text()).toBe(raw);
    }
  });
  it("cancels a stalled buffer promptly when the client disconnects", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise(() => {}));
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ping\n\n")); }, cancel }), { headers: { "content-type": "text/event-stream" } });
    const pending = classifyResponse(response, "claude", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect((await pending).replay.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces a total buffer deadline even when pings keep arriving", async () => {
    vi.useFakeTimers();
    let interval;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(c) { interval = setInterval(() => { try { c.enqueue(new TextEncoder().encode(": ping\n\n")); } catch {} }, 1000); }, cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const pending = classifyResponse(response, "claude");
    await vi.advanceTimersByTimeAsync(MAX_VAULT_LOOP_MS + 1);
    expect((await pending).replay.status).toBe(502);
    clearInterval(interval);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("allows healthy long thinking before any vault retrieval starts", async () => {
    vi.useFakeTimers();
    let output;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { output = c; }, cancel }), { headers: { "content-type": "text/event-stream" } });
    const raw = frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    output.enqueue(new TextEncoder().encode(raw));
    const pending = runVaultLoop({ dispatch: async () => response, body: { messages: [] }, wire: "claude", conversationId: "c" });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      output.enqueue(new TextEncoder().encode(frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "healthy progress" } })));
    }
    output.enqueue(new TextEncoder().encode(frame({ type: "message_stop" })));
    output.close();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("healthy progress");
    expect(cancel).not.toHaveBeenCalled();
  });
  it("applies the shorter deadline only after hidden retrieval begins", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn().mockResolvedValueOnce(claudeCall()).mockImplementationOnce(() => new Promise(() => {}));
    const pending = runVaultLoop({ dispatch, body: { messages: [] }, wire: "claude", conversationId: "c" });
    await vi.advanceTimersByTimeAsync(MAX_VAULT_INTERNAL_MS + 1);
    expect((await pending).status).toBe(502);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized buffered responses", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_VAULT_BUFFER_BYTES + 1)); }, cancel }), { headers: { "content-type": "text/event-stream" } });
    expect((await classifyResponse(response, "claude")).replay.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("stops subsequent model turns when cancellation occurs during search", async () => {
    const controller = new AbortController();
    search.mockImplementation(async () => { controller.abort(); return []; });
    const dispatch = vi.fn(async () => claudeCall());
    const response = await runVaultLoop({ dispatch, body: { messages: [] }, wire: "claude", conversationId: "c", signal: controller.signal });
    expect(response.status).toBe(499);
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("bounds a hung search and returns an explicit retryable error", async () => {
    vi.useFakeTimers();
    search.mockImplementation(() => new Promise(() => {}));
    const dispatch = vi.fn(async () => claudeCall());
    const pending = runVaultLoop({ dispatch, body: { messages: [] }, wire: "claude", conversationId: "c" });
    await vi.advanceTimersByTimeAsync(VAULT_SEARCH_TIMEOUT_MS + 1);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("bounds dispatch even when a provider ignores its abort signal", async () => {
    vi.useFakeTimers();
    const pending = runVaultLoop({ dispatch: () => new Promise(() => {}), body: { messages: [] }, wire: "claude", conversationId: "c" });
    await vi.advanceTimersByTimeAsync(MAX_VAULT_LOOP_MS + 1);
    expect((await pending).status).toBe(502);
  });
  it("never overwrites successful tool output merely mentioning an error", async () => {
    const text = "[chunk 1]\nError: unknown tool sb_vault_search\nthis is genuine stored log text";
    const body = { messages: [{ role: "assistant", content: [tool()] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: text }] }] };
    expect(await repairInboundVaultResults(body, { conversationId: "c" })).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(body.messages[1].content[0].content).toBe(text);
  });
  it("caps repair searches across the entire request and clears only repaired error flags", async () => {
    const body = { messages: Array.from({ length: 101 }, (_, i) => [
      { role: "assistant", content: [tool("call_" + i)] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_" + i, content: "Unknown tool sb_vault_search", is_error: true, status: "error" }] },
    ]).flat() };
    expect(await repairInboundVaultResults(body, { conversationId: "c" })).toBe(100);
    expect(search).toHaveBeenCalledTimes(100);
    expect(body.messages[1].content[0]).not.toHaveProperty("is_error");
    expect(body.messages[1].content[0]).not.toHaveProperty("status");
    expect(body.messages.at(-1).content[0].is_error).toBe(true);
  });
});
