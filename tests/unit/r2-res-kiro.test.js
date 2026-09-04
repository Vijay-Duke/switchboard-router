/** Round-2 response findings: kiro translators (R2-X11..X19). */
import { describe, it, expect } from "vitest";
import { kiroToClaudeResponse, kiroToClaudeNonStreaming } from "../../open-sse/translator/response/kiro-to-claude.js";
import { kiroToOpenAIResponse } from "../../open-sse/translator/response/kiro-to-openai.js";

function freshClaude() {
  return { toolCalls: new Map() };
}
const ocChunk = (delta, finish = null) => ({
  id: "chatcmpl-abc123", model: "k", choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("R2-X11 chatcmpl strip anchored (kiro->claude)", () => {
  it("mid-string preserved, prefix stripped", () => {
    const s1 = freshClaude();
    kiroToClaudeResponse({ ...ocChunk({ content: "h" }), id: "xchatcmpl-y" }, s1);
    expect(s1.messageId).toBe("xchatcmpl-y");
  });
});

describe("R2-X12 reasoning_details thinking", () => {
  it("all three shapes open exactly one thinking block", () => {
    for (const delta of [
      { reasoning_content: "a" },
      { reasoning: "b" },
      { reasoning_details: [{ text: "c" }] },
    ]) {
      const out = kiroToClaudeResponse(ocChunk(delta), freshClaude());
      const starts = out.filter((e) => e.type === "content_block_start" && e.content_block?.type === "thinking");
      expect(starts).toHaveLength(1);
    }
  });
});

describe("R2-X13 object tool arguments", () => {
  it("object, string, and missing args all project to valid JSON", () => {
    const run = (args) => {
      const state = freshClaude();
      const all = [];
      const evts = [
        ocChunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "T", arguments: args } }] }),
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      for (const e of evts) {
        const out = kiroToClaudeResponse(e, state);
        if (out) all.push(...out);
      }
      return all.find((x) => x.delta?.type === "input_json_delta")?.delta.partial_json;
    };
    expect(JSON.parse(run({ a: 1 }))).toEqual({ a: 1 });
    expect(JSON.parse(run('{"a":1}'))).toEqual({ a: 1 });
  });
});

describe("R2-X14 non-streaming reasoning + cache", () => {
  it("reasoning maps to thinking block; cache details survive", () => {
    const out = kiroToClaudeNonStreaming({
      model: "k",
      choices: [{ finish_reason: "stop", message: { content: "hi", reasoning_content: "thinkthink" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 } },
    });
    expect(out.content[0]).toMatchObject({ type: "thinking", thinking: "thinkthink" });
    expect(out.usage).toMatchObject({ input_tokens: 4, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 });
  });
});

describe("R2-X15 empty-stream flush (gate ruling: no synthetic empty turn)", () => {
  it("null-flush on fresh state emits nothing; flush after message_start still terminates", () => {
    expect(kiroToClaudeResponse(null, freshClaude())).toBeNull();
    const state = freshClaude();
    kiroToClaudeResponse(ocChunk({ content: "h" }), state);
    const out = kiroToClaudeResponse(null, state);
    expect(out[out.length - 2].type).toBe("message_delta");
    expect(out[out.length - 1].type).toBe("message_stop");
  });
});

describe("R2-X16 cache usage folded (kiro->claude)", () => {
  it("cached chunk yields input 4 + both detail keys", () => {
    const state = freshClaude();
    kiroToClaudeResponse({
      ...ocChunk({ content: "h" }),
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 } },
    }, state);
    expect(state.usage).toMatchObject({ input_tokens: 4, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 });
  });
});

describe("R2-X17 string tool input passthrough", () => {
  it("string input byte-identical; object stringifies once", () => {
    const s1 = {};
    const a = kiroToOpenAIResponse({ toolUseEvent: { toolUseId: "t1", name: "T", input: '{"a":1}' }, _eventType: "toolUseEvent" }, s1);
    expect(a.choices[0].delta.tool_calls[0].function.arguments).toBe('{"a":1}');
    const s2 = {};
    const b = kiroToOpenAIResponse({ toolUseEvent: { toolUseId: "t1", name: "T", input: { a: 1 } }, _eventType: "toolUseEvent" }, s2);
    expect(b.choices[0].delta.tool_calls[0].function.arguments).toBe('{"a":1}');
  });
});

describe("R2-X18 stop deferred until usage", () => {
  it("stop, usage, flush yields exactly one finish chunk carrying usage", () => {
    const state = {};
    expect(kiroToOpenAIResponse({ _eventType: "messageStopEvent" }, state)).toBeNull();
    const withUsage = kiroToOpenAIResponse({ usageEvent: { inputTokens: 3, outputTokens: 1 }, _eventType: "usageEvent" }, state);
    expect(withUsage.choices[0].finish_reason).toBe("stop");
    expect(withUsage.usage.prompt_tokens).toBe(3);
    expect(kiroToOpenAIResponse(null, state)).toBeNull();
  });
  it("stop alone + flush still terminates", () => {
    const state = {};
    kiroToOpenAIResponse({ _eventType: "messageStopEvent" }, state);
    const flushed = kiroToOpenAIResponse(null, state);
    expect(flushed.choices[0].finish_reason).toBe("stop");
  });
});

describe("R2-X19 weblinks + codeEvent", () => {
  it("weblinks event yields content chunk with each URL", () => {
    const out = kiroToOpenAIResponse({
      supplementaryWebLinksEvent: { supplementaryWebLinks: [{ title: "T", url: "https://a/x" }, { url: "https://b/y" }] },
      _eventType: "supplementaryWebLinksEvent",
    }, {});
    expect(out.choices[0].delta.content).toContain("https://a/x");
    expect(out.choices[0].delta.content).toContain("https://b/y");
  });
  it("raw codeEvent falls back to content", () => {
    const out = kiroToOpenAIResponse({ codeEvent: { content: "print(1)" }, _eventType: "codeEvent" }, {});
    expect(out.choices[0].delta.content).toBe("print(1)");
  });
});
