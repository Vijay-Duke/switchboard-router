import { describe, expect, it, vi } from "vitest";
import { classifyResponse, appendVaultTurn, STREAM_BUFFER_IDLE_MS } from "../../open-sse/rtk/vaultLoop.js";
const call = { type: "tool_use", id: "vault-call", name: "sb_vault_search", input: { query: "needle" } };
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const stream = events => new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
const events = extra => [
  { type: "content_block_start", index: 0, content_block: extra },
  { type: "content_block_start", index: 1, content_block: call },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];
describe("Claude vault replay preserves signed and provider-managed history", () => {
  it("preserves thinking and fragmented signatures in a replayed vault assistant turn", async () => {
    const result = await classifyResponse(stream([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } },
      { type: "content_block_start", index: 1, content_block: call },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]), "claude");
    expect(result.kind).toBe("call");
    const replay = appendVaultTurn({ messages: [] }, "claude", result, ["actual result"]);
    expect(replay.messages[0].content).toEqual([{ type: "thinking", thinking: "Reasoning", signature: "sig-opaque" }, call]);
    expect(replay.messages[1].content[0].tool_use_id).toBe(call.id);
    expect(result.calls[0].query).toBe("needle");
  });
  it("preserves redacted thinking bytes", async () => {
    const encrypted = { type: "redacted_thinking", data: "opaque-encrypted-data" };
    const result = await classifyResponse(stream(events(encrypted)), "claude");
    expect(result.assistantRaw).toEqual([encrypted, call]);
  });
  it.each(["server_tool_use", "mcp_tool_use", "web_search_tool_result", "future_provider_block"])("forwards %s mixed with vault calls untouched for JSON and SSE", async type => {
    const extra = { type, id: "provider-call", name: "web_search", input: {} };
    for (const response of [Response.json({ content: [extra, call] }), stream(events(extra))]) {
      const result = await classifyResponse(response, "claude");
      expect(result.kind).toBe("mixed");
      expect(await result.replay.text()).toContain(type);
    }
  });
  it("forwards a tool turn containing an upstream error without executing a vault call", async () => {
    const result = await classifyResponse(stream([
      { type: "content_block_start", index: 0, content_block: call },
      { type: "error", error: { type: "api_error", message: "upstream interrupted" } },
    ]), "claude");
    expect(result.kind).toBe("mixed");
    expect(await result.replay.text()).toContain("upstream interrupted");
  });
});

it("bounds vault stream stalls even when cancellation never resolves", async () => {
  vi.useFakeTimers();
  try {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(": ping\n\n")); },
      cancel() { return new Promise(() => {}); },
    }), { headers: { "content-type": "text/event-stream" } });
    let settled = false;
    const classified = classifyResponse(response, "claude").then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(STREAM_BUFFER_IDLE_MS + 1);
    expect(settled).toBe(true);
    const result = await classified;
    expect(result.replay.status).toBe(502);
    expect(await result.replay.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  } finally { vi.useRealTimers(); }
});
it("reports an interrupted buffered stream as an error rather than a used 200 body", async () => {
  const result = await classifyResponse(new Response(new ReadableStream({
    start(controller) { controller.error(new Error("synthetic body failure")); },
  }), { headers: { "content-type": "text/event-stream" } }), "claude");
  expect(result.replay.status).toBe(502);
  expect(await result.replay.json()).toMatchObject({ type: "error" });
});
