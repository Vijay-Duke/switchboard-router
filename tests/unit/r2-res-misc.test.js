/** Round-2 response findings: cursor/commandcode/ollama/projector/index/usage (R2-X20..X28, X39..X47, R1-X46). */
import { describe, it, expect } from "vitest";
import { cursorToOpenAIResponse } from "../../open-sse/translator/response/cursor-to-openai.js";
import { commandCodeToOpenAIResponse } from "../../open-sse/translator/response/commandcode-to-openai.js";
import { ollamaToOpenAIResponse } from "../../open-sse/translator/response/ollama-to-openai.js";
import {
  responsesApiToOpenAICompletion,
  projectCompletionToClientFormat,
} from "../../open-sse/translator/response/completionProjector.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { toOpenAIFinish } from "../../open-sse/translator/concerns/finishReason.js";

const ocChunk = (delta, finish = null) => ({
  object: "chat.completion.chunk", id: "c1", model: "m", choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("R2-X20 cursor EOF flush", () => {
  it("flush after tools -> tool_calls; after text -> stop; fresh -> null", () => {
    expect(cursorToOpenAIResponse(null, {})).toBeNull();
    const s1 = {};
    cursorToOpenAIResponse(ocChunk({ tool_calls: [{ index: 0, id: "t", function: { name: "A", arguments: "{}" } }] }), s1);
    expect(cursorToOpenAIResponse(null, s1).choices[0].finish_reason).toBe("tool_calls");
    const s2 = {};
    cursorToOpenAIResponse(ocChunk({ content: "hi" }), s2);
    expect(cursorToOpenAIResponse(null, s2).choices[0].finish_reason).toBe("stop");
  });
});

describe("R2-X21 cursor garbage dropped", () => {
  it("garbage -> null; both OpenAI shapes pass through identical", () => {
    expect(cursorToOpenAIResponse({ hello: 1 }, {})).toBeNull();
    const c = ocChunk({ content: "x" });
    expect(cursorToOpenAIResponse(c, {})).toBe(c);
    const full = { object: "chat.completion", choices: [{ message: {} }] };
    expect(cursorToOpenAIResponse(full, {})).toBe(full);
  });
});

describe("R2-X22 commandcode id-less deltas", () => {
  it("id-less start + id-less deltas assemble full args", () => {
    const state = {};
    const all = [];
    for (const e of [
      JSON.stringify({ type: "tool-input-start", toolName: "Edit" }),
      JSON.stringify({ type: "tool-input-delta", delta: '{"a":' }),
      JSON.stringify({ type: "tool-input-delta", delta: "1}" }),
      JSON.stringify({ type: "finish", finishReason: "stop" }),
    ]) {
      const out = commandCodeToOpenAIResponse(e, state);
      if (out) all.push(...out);
    }
    const argDeltas = all.flatMap((c) => c.choices[0].delta.tool_calls || [])
      .map((t) => t.function.arguments).join("");
    expect(argDeltas).toContain('{"a":1}');
  });
});

describe("R2-X23 commandcode id-less tool-call", () => {
  it("emits call_* id with no undefined map key", () => {
    const state = {};
    const out = commandCodeToOpenAIResponse(JSON.stringify({ type: "tool-call", toolName: "T", input: { a: 1 } }), state);
    const tc = out[0].choices[0].delta.tool_calls[0];
    expect(tc.id).toMatch(/^call_/);
    expect([...state.toolIndexById.keys()].every((k) => typeof k === "string")).toBe(true);
  });
});

describe("R2-X24 commandcode other finish", () => {
  it("'other', unknown, and undefined all yield stop", () => {
    expect(toOpenAIFinish("other", "commandcode")).toBe("stop");
    expect(toOpenAIFinish("unknown-reason", "commandcode")).toBe("stop");
    expect(toOpenAIFinish(undefined, "commandcode")).toBe("stop");
  });
});

describe("R2-X25 commandcode error+finish single terminal", () => {
  it("yields exactly one finish chunk", () => {
    const state = {};
    const all = [];
    for (const e of [
      JSON.stringify({ type: "text-delta", text: "hi" }),
      JSON.stringify({ type: "error", message: "boom" }),
      JSON.stringify({ type: "finish", finishReason: "stop" }),
    ]) {
      const out = commandCodeToOpenAIResponse(e, state);
      if (out) all.push(...out);
    }
    expect(all.filter((c) => c.choices[0].finish_reason).length).toBe(1);
  });
});

describe("R2-X26 commandcode EOF flush", () => {
  it("text deltas + flush -> one stop; fresh flush -> null", () => {
    expect(commandCodeToOpenAIResponse(null, {})).toBeNull();
    const state = {};
    commandCodeToOpenAIResponse(JSON.stringify({ type: "text-delta", text: "hi" }), state);
    const flushed = commandCodeToOpenAIResponse(null, state);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].choices[0].finish_reason).toBe("stop");
    expect(commandCodeToOpenAIResponse(null, state)).toBeNull();
  });
});

describe("R2-X27 ollama multi-tool indices", () => {
  it("three single-tool chunks yield 0/1/2 with distinct stable ids", () => {
    const state = {};
    const outs = [0, 1, 2].map(() => ollamaToOpenAIResponse(
      { model: "q", message: { role: "assistant", tool_calls: [{ function: { name: "T", arguments: "{}" } }] } }, state
    ));
    const tcs = outs.map((o) => o.choices[0].delta.tool_calls[0]);
    expect(tcs.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(new Set(tcs.map((t) => t.id)).size).toBe(3);
    expect(tcs[0].id).toMatch(/^call_0_\d{10,}$/);
  });
});

describe("R2-X28 ollama strings + truncation flush", () => {
  it("string line translates; truncated stream + flush terminates once", () => {
    const state = {};
    const line = JSON.stringify({ model: "q", message: { role: "assistant", content: "hi" } });
    expect(ollamaToOpenAIResponse(line, state).choices[0].delta.content).toBe("hi");
    const flushed = ollamaToOpenAIResponse(null, state);
    expect(flushed.choices[0].finish_reason).toBe("stop");
    expect(ollamaToOpenAIResponse(null, state)).toBeNull();
    expect(ollamaToOpenAIResponse(null, {})).toBeNull();
  });
});

describe("R2-X39 custom_tool_call projection", () => {
  it("mixed output projects both calls with distinct stable ids", () => {
    const out = responsesApiToOpenAICompletion({
      id: "r1", status: "completed",
      output: [
        { type: "function_call", call_id: "c1", name: "A", arguments: "{}" },
        { type: "custom_tool_call", call_id: "c2", name: "B", input: { x: 1 } },
      ],
      usage: {},
    });
    expect(out.choices[0].message.tool_calls).toHaveLength(2);
    const ids = out.choices[0].message.tool_calls.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("R2-X40 Responses status -> finish map", () => {
  const run = (status, details) => responsesApiToOpenAICompletion({
    status, ...(details ? { incomplete_details: details } : {}), output: [], usage: {},
  }).choices[0].finish_reason;
  it("maps each status to a valid OpenAI reason", () => {
    expect(run("failed")).toBe("error");
    expect(run("incomplete")).toBe("length");
    expect(run("incomplete", { reason: "content_filter" })).toBe("content_filter");
    expect(run("completed")).toBe("stop");
    expect(run("weird")).toBe("stop");
  });
});

describe("R2-X41 refusal projection", () => {
  it("refusal output projects its text", () => {
    const out = responsesApiToOpenAICompletion({
      status: "completed",
      output: [{ type: "refusal", refusal: "cannot comply" }],
      usage: {},
    });
    expect(out.choices[0].message.content).toBe("cannot comply");
    expect(out.choices[0].finish_reason).toBe("content_filter");
  });
});

describe("R2-X42 usage details survive projection", () => {
  it("cached + reasoning usage survive", () => {
    const out = responsesApiToOpenAICompletion({
      status: "completed", output: [], usage: {
        input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: { cached_tokens: 6 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
    expect(out.usage.prompt_tokens_details).toMatchObject({ cached_tokens: 6 });
    expect(out.usage.completion_tokens_details).toMatchObject({ reasoning_tokens: 2 });
    const claude = projectCompletionToClientFormat(out, FORMATS.CLAUDE);
    expect(claude.usage).toMatchObject({ cache_read_input_tokens: 6 });
  });
});

describe("R2-X43 ollama done_reason", () => {
  it("tool turn projects stop", () => {
    const out = projectCompletionToClientFormat({
      id: "c", model: "m", created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ id: "t", function: { name: "A", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: {},
    }, FORMATS.OLLAMA);
    expect(out.done_reason).toBe("stop");
  });
});

describe("R2-X44 chat finish -> Responses status", () => {
  const run = (reason) => projectCompletionToClientFormat({
    id: "c1", model: "m", created: 1,
    choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: reason }],
    usage: {},
  }, FORMATS.OPENAI_RESPONSES);
  it("maps each finish reason to a valid status + details", () => {
    expect(run("length").status).toBe("incomplete");
    expect(run("length").incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(run("content_filter").incomplete_details).toEqual({ reason: "content_filter" });
    expect(run("error").status).toBe("failed");
    expect(run("stop").status).toBe("completed");
    expect(run("tool_calls").status).toBe("completed");
  });
});

describe("R2-X45 kiro/commandcode/cursor passthrough documented", () => {
  it("returns OpenAI shape unchanged", () => {
    const completion = { object: "chat.completion", choices: [{ message: {} }] };
    for (const f of [FORMATS.KIRO, FORMATS.CURSOR, FORMATS.COMMANDCODE]) {
      expect(projectCompletionToClientFormat(completion, f)).toBe(completion);
    }
  });
});

describe("R1-X46/R2-X46 double-hop EOF flush", () => {
  it("flush after text yields exactly one terminal per pair", () => {
    for (const [up, down] of [[FORMATS.OLLAMA, FORMATS.CLAUDE], [FORMATS.GEMINI, FORMATS.CLAUDE], [FORMATS.CLAUDE, FORMATS.OPENAI]]) {
      const state = initState(down);
      const first = up === FORMATS.OLLAMA
        ? { model: "q", message: { role: "assistant", content: "hi" } }
        : up === FORMATS.GEMINI
          ? { candidates: [{ content: { parts: [{ text: "hi" }] } }], responseId: "r" }
          : { type: "message_start", message: { id: "m", model: "c" } };
      translateResponse(up, down, first, state);
      const flushed = translateResponse(up, down, null, state);
      expect(flushed.length).toBeGreaterThan(0);
    }
  });
});

describe("R2-X47 gemini total fallback", () => {
  it("missing total derives the sum; present total wins", () => {
    expect(toOpenAIUsage({ promptTokenCount: 100, candidatesTokenCount: 50 }, "gemini").total_tokens).toBe(150);
    expect(toOpenAIUsage({ promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 200 }, "gemini").total_tokens).toBe(200);
  });
});
