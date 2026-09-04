/** Round-2 response findings: claude-to-openai (R1-X1..X7, R2-X32/X33). */
import { describe, it, expect } from "vitest";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function fresh() {
  return { toolCalls: new Map(), ...initState(FORMATS.OPENAI) };
}

function feed(events, state = fresh()) {
  const all = [];
  for (const e of events) {
    const out = claudeToOpenAIResponse(e, state);
    if (out) all.push(...out);
  }
  return { state, chunks: all };
}

describe("R1-X1 mid-stream error event", () => {
  it("emits one terminal chunk, ping stays null, later message_stop silent", () => {
    const state = fresh();
    expect(claudeToOpenAIResponse({ type: "ping" }, state)).toBeNull();
    const out = claudeToOpenAIResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, state);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].finish_reason).toBe("stop");
    expect(out[0].choices[0].delta.content).toContain("Overloaded");
    expect(claudeToOpenAIResponse({ type: "message_stop" }, state)).toBeNull();
  });
});

describe("R1-X2 cloaked tool name restore", () => {
  it("restores the mapped name verbatim (no proxy_ mangling: request side no longer prefixes)", () => {
    const state = fresh();
    state.toolNameMap = new Map([["proxy_Read_ide", "proxy_Read"]]);
    const { chunks } = feed([
      { type: "message_start", message: { id: "m1", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "proxy_Read_ide" } },
    ], state);
    expect(chunks[1].choices[0].delta.tool_calls[0].function.name).toBe("proxy_Read");
  });
});

describe("R1-X3/R2-X32 message_stop usage keeps cache", () => {
  it("stop-only path matches delta path (prompt 125 + details)", () => {
    const start = { type: "message_start", message: { id: "m", model: "c", usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } };
    const { chunks: stopChunks } = feed([start, { type: "message_stop" }]);
    const stopUsage = stopChunks[stopChunks.length - 1].usage;
    expect(stopUsage.prompt_tokens).toBe(125);
    expect(stopUsage.prompt_tokens_details.cached_tokens).toBe(20);
    const { chunks: deltaChunks } = feed([
      start,
      { type: "message_delta", usage: { output_tokens: 7 }, delta: { stop_reason: "end_turn" } },
    ]);
    expect(deltaChunks[deltaChunks.length - 1].usage.prompt_tokens).toBe(125);
  });
});

describe("R1-X4 indexless delta on fresh state", () => {
  it("emits content; armed server-tool index still skipped", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    ]);
    expect(chunks.some((c) => c.choices[0].delta?.content === "hi")).toBe(true);

    const s2 = fresh();
    feed([
      { type: "content_block_start", index: 3, content_block: { type: "server_tool_use" } },
    ], s2);
    expect(claudeToOpenAIResponse(
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } }, s2
    )).toBeNull();
  });
});

describe("R1-X6 model fallback", () => {
  it("model-less start emits 'unknown', never undefined", () => {
    const { chunks } = feed([{ type: "message_start", message: { id: "m" } }]);
    expect(chunks[0].model).toBe("unknown");
  });
});

describe("R1-X7 stable created", () => {
  it("two emissions from one stream share created", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
    ]);
    expect(chunks[0].created).toBe(chunks[1].created);
  });
});

describe("first-leg EOF flush terminates", () => {
  it("flush after text yields one stop chunk with usage; virgin flush null", () => {
    expect(claudeToOpenAIResponse(null, fresh())).toBeNull();
    const state = fresh();
    feed([
      { type: "message_start", message: { id: "m", model: "c", usage: { input_tokens: 5 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    ], state);
    const flushed = claudeToOpenAIResponse(null, state);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].choices[0].finish_reason).toBe("stop");
    expect(flushed[0].usage.prompt_tokens).toBe(5);
    expect(claudeToOpenAIResponse(null, state)).toBeNull();
  });
});

describe("R2-X33 redacted thinking + web search results", () => {
  it("redacted_thinking yields a reasoning delta", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "enc" } },
    ]);
    expect(chunks.some((c) => c.choices[0].delta?.reasoning_content === "[redacted]")).toBe(true);
  });
  it("redacted_thinking never leaks ciphertext or a stray </think> marker", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "ENCRYPTED_BLOB" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
    ]);
    const text = chunks.map((c) => c.choices[0].delta?.content || "").join("");
    expect(text).toBe("hi");
    expect(JSON.stringify(chunks)).not.toContain("ENCRYPTED_BLOB");
  });
  it("web_search_tool_result yields markdown citations without encrypted_content", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url: "https://a.example/x", title: "A page", encrypted_content: "CIPHER", page_age: null },
        { type: "web_search_result", url: "https://b.example/y", title: "", encrypted_content: "CIPHER2" },
      ] } },
    ]);
    const text = chunks.map((c) => c.choices[0].delta?.content || "").join("");
    expect(text).toContain("[A page](https://a.example/x)");
    expect(text).toContain("[https://b.example/y](https://b.example/y)");
    expect(text).not.toContain("CIPHER");
  });
  it("web_search_tool_result with no usable links emits a placeholder", () => {
    const { chunks } = feed([
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } },
    ]);
    expect(chunks.some((c) => c.choices[0].delta?.content === "[web search results omitted]")).toBe(true);
  });
});
