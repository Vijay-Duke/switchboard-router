/** Round-2 response findings: openai-to-claude (R1-X13..X18, R2-X34..X36). */
import { describe, it, expect } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function fresh() {
  return { toolCalls: new Map() };
}

function feed(events, state = fresh()) {
  const all = [];
  for (const e of events) {
    const out = openaiToClaudeResponse(e, state);
    if (out) all.push(...out);
  }
  return { state, events: all };
}

const chunk = (delta, extra = {}) => ({
  id: "chatcmpl-abc123", model: "m", choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});
const fin = (reason) => ({
  id: "chatcmpl-abc123", model: "m", choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

describe("R1-X13 args-first tool chunks", () => {
  it("late name resolves to a correctly named block", () => {
    const { events } = feed([
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_abc", function: { name: "MyTool" } }] }),
      fin("tool_calls"),
    ]);
    const start = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(start.content_block.name).toBe("MyTool");
    const delta = events.find((e) => e.delta?.type === "input_json_delta");
    expect(delta.delta.partial_json).toBe('{"q":"x"}');
  });
});

describe("R1-X14 tool id sanitization", () => {
  it("'my.tool:1 x' becomes charset-clean; empty-after-strip falls back", () => {
    const { events } = feed([
      chunk({ tool_calls: [{ index: 0, id: "my.tool:1 x", function: { name: "T", arguments: "{}" } }] }),
      fin("tool_calls"),
    ]);
    const start = events.find((e) => e.content_block?.type === "tool_use");
    expect(start.content_block.id).toBe("mytool1x");

    const s2 = fresh();
    const { events: e2 } = feed([
      chunk({ tool_calls: [{ index: 0, id: "...", function: { name: "T" } }] }),
      fin("stop"),
    ], s2);
    const start2 = e2.find((e) => e.content_block?.type === "tool_use");
    expect(start2.content_block.id).toMatch(/^toolu_/);
  });
});

describe("R1-X15 trailing usage-only chunk", () => {
  it("updates state.usage after finish", () => {
    const state = fresh();
    feed([chunk({ content: "hi" }), fin("stop")], state);
    openaiToClaudeResponse({ id: "x", usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }, state);
    expect(state.usage).toMatchObject({ input_tokens: 9, output_tokens: 3 });
  });
});

describe("R1-X16 audio + refusal deltas", () => {
  it("each emits a verbatim text_delta", () => {
    const { events } = feed([
      chunk({ audio: { transcript: "hello world" } }),
      chunk({ refusal: "I cannot do that" }),
    ]);
    const texts = events.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text);
    expect(texts).toContain("hello world");
    expect(texts).toContain("I cannot do that");
  });
});

describe("R1-X17/R2-X36 chatcmpl prefix anchoring", () => {
  it("mid-string occurrence preserved, real prefix stripped", () => {
    const s1 = fresh();
    feed([{ id: "xchatcmpl-y", model: "m", choices: [{ index: 0, delta: { content: "h" }, finish_reason: null }] }], s1);
    expect(s1.messageId).toBe("xchatcmpl-y");
    const s2 = fresh();
    feed([{ id: "chatcmpl-abc12345", model: "m", choices: [{ index: 0, delta: { content: "h" }, finish_reason: null }] }], s2);
    expect(s2.messageId).toBe("abc12345");
  });
});

describe("R1-X18 doubled-JSON fast path", () => {
  it("200KB garbage returns fast and unmodified; exact doubling dedups", () => {
    const big = "x".repeat(200 * 1024);
    const t0 = Date.now();
    const { events } = feed([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "T", arguments: '{"a":1' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: big } }] }),
      fin("tool_calls"),
    ]);
    expect(Date.now() - t0).toBeLessThan(50);
    const delta = events.find((e) => e.delta?.type === "input_json_delta");
    expect(delta.delta.partial_json.length).toBeGreaterThan(100000);
  });
  it("exact doubling still dedups", () => {
    const half = '{"q":"x"}';
    const { events } = feed([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "T", arguments: half } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: half } }] }),
      fin("tool_calls"),
    ]);
    const delta = events.find((e) => e.delta?.type === "input_json_delta");
    expect(delta.delta.partial_json).toBe(half);
  });
});

describe("R2-X34 negative input_tokens clamp", () => {
  it("over-cache chunk clamps to 0 with detail keys kept", () => {
    const state = fresh();
    openaiToClaudeResponse({
      id: "chatcmpl-abc123", model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 8, cache_creation_tokens: 4 } },
    }, state);
    expect(state.usage.input_tokens).toBe(0);
    expect(state.usage.cache_read_input_tokens).toBe(8);
  });
});

describe("R2-X35 empty-stream flush (gate ruling: no synthetic empty turn)", () => {
  it("null-flush on fresh state emits nothing (no bare message_delta/message_stop either)", () => {
    expect(openaiToClaudeResponse(null, fresh())).toBeNull();
  });
  it("flush after message_start still terminates once", () => {
    const state = fresh();
    feed([chunk({ content: "hi" })], state);
    const out = openaiToClaudeResponse(null, state);
    expect(out.map((e) => e.type).slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(openaiToClaudeResponse(null, state)).toBeNull();
  });
});

describe("gemini image content blocks reach Claude", () => {
  it("image_url content block becomes a Claude image block", () => {
    const { events } = feed([
      chunk({ content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }),
    ]);
    const img = events.find((e) => e.content_block?.type === "image");
    expect(img.content_block.source).toMatchObject({ type: "base64", media_type: "image/png" });
  });
});
