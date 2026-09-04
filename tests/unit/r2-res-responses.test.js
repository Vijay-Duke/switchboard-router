/** Round-2 response findings: openai-responses both directions (R2-X1..X10). */
import { describe, it, expect } from "vitest";
import {
  openaiToOpenAIResponsesResponse,
  openaiResponsesToOpenAIResponse,
} from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function freshResponses() {
  return initState(FORMATS.OPENAI_RESPONSES);
}
function freshChat() {
  return {};
}

const ocChunk = (delta, finish = null, id = "chatcmpl-1") => ({
  id, model: "m", choices: [{ index: 0, delta, finish_reason: finish }],
});

function feedToResponses(events, state = freshResponses()) {
  const all = [];
  for (const e of events) all.push(...openaiToOpenAIResponsesResponse(e, state));
  return { state, events: all };
}
function feedToChat(events, state = freshChat()) {
  const all = [];
  for (const e of events) {
    const out = openaiResponsesToOpenAIResponse(e, state);
    if (out) all.push(out);
  }
  return { state, chunks: all };
}
const addedOf = (events) => events.filter((e) => e.event === "response.output_item.added");

describe("R2-X1 distinct output_index", () => {
  it("text + 2 tool calls yield 3 distinct indices with matching routing", () => {
    const { events } = feedToResponses([
      ocChunk({ content: "hi" }),
      ocChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "A", arguments: "{}" } }] }),
      ocChunk({ tool_calls: [{ index: 1, id: "c2", function: { name: "B", arguments: "{}" } }] }),
      ocChunk({}, "tool_calls"),
    ]);
    const idx = addedOf(events).map((e) => e.data.output_index);
    expect(new Set(idx).size).toBe(3);
    for (const e of events) {
      if (e.data.item_id) {
        const owner = e.data.item_id.startsWith("msg_") ? "msg" : "tool";
        void owner;
      }
    }
    // deltas/done reuse the added index of their item
    const toolDeltas = events.filter((e) => e.event === "response.function_call_arguments.delta");
    const toolDones = events.filter((e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call");
    expect(toolDeltas[0].data.output_index).toBe(toolDones[0].data.output_index);
  });
});

describe("R2-X2 id-less tool call survives", () => {
  it("name+args without id yields one function_call item with stable call_id", () => {
    const { events } = feedToResponses([
      ocChunk({ tool_calls: [{ index: 0, function: { name: "A", arguments: '{"x":1}' } }] }),
      ocChunk({}, "tool_calls"),
    ]);
    const added = addedOf(events).filter((e) => e.data.item?.type === "function_call");
    expect(added).toHaveLength(1);
    expect(added[0].data.item.call_id).toMatch(/^call_0_/);
    const done = events.find((e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call");
    expect(done.data.item.call_id).toBe(added[0].data.item.call_id);
  });
});

describe("R2-X3 length/content_filter -> incomplete", () => {
  it("length yields incomplete/max_output_tokens; tool_calls still completed", () => {
    const { events } = feedToResponses([ocChunk({ content: "p" }), ocChunk({}, "length")]);
    const term = events.find((e) => e.event === "response.incomplete");
    expect(term.data.response.incomplete_details.reason).toBe("max_output_tokens");
    expect(events.some((e) => e.event === "response.completed")).toBe(false);

    const { events: cf } = feedToResponses([ocChunk({ content: "p" }), ocChunk({}, "content_filter")]);
    expect(cf.find((e) => e.event === "response.incomplete").data.response.incomplete_details.reason).toBe("content_filter");

    const { events: tc } = feedToResponses([
      ocChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "A", arguments: "{}" } }] }),
      ocChunk({}, "length"),
    ]);
    expect(tc.some((e) => e.event === "response.completed")).toBe(true);
  });
});

describe("R2-X4 usage forwarded", () => {
  it("finish usage lands on completed.response.usage; usage-only chunks harvested", () => {
    const { events } = feedToResponses([
      ocChunk({ content: "p" }),
      { ...ocChunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } } },
    ]);
    const done = events.find((e) => e.event === "response.completed");
    expect(done.data.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });

    const state = freshResponses();
    feedToResponses([ocChunk({ content: "p" })], state);
    feedToResponses([{ usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }], state);
    expect(state.usage.prompt_tokens).toBe(7);
  });
});

describe("R2-X6 first chunk role (responses -> chat)", () => {
  it("first delta has role assistant; later chunks do not repeat", () => {
    const { chunks } = feedToChat([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.output_text.delta", delta: " there" },
    ]);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].delta.role).toBeUndefined();
  });
});

describe("R2-X5 parallel responses tool calls", () => {
  it("two concurrent calls get indices 0/1 end to end", () => {
    const { chunks } = feedToChat([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "A", name: "fa" } },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "B", name: "fb" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_A", delta: '{"x":1}' },
      { type: "response.function_call_arguments.delta", item_id: "fc_B", delta: '{"y":2}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "A" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "B" } },
      { type: "response.completed", response: {} },
    ]);
    const tools = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
    const byId = Object.fromEntries(tools.filter((t) => t.id).map((t) => [t.id, t.index]));
    expect(byId.A).toBe(0);
    expect(byId.B).toBe(1);
    const argDeltas = tools.filter((t) => !t.id);
    expect(argDeltas.find((t) => t.function.arguments === '{"x":1}').index).toBe(0);
    expect(argDeltas.find((t) => t.function.arguments === '{"y":2}').index).toBe(1);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("R2-X7 refusal handling", () => {
  it("refusal delta reaches client; refusal-only turn finishes content_filter", () => {
    const { chunks } = feedToChat([
      { type: "response.refusal.delta", delta: "nope" },
      { type: "response.completed", response: {} },
    ]);
    expect(chunks[0].choices[0].delta.content).toBe("nope");
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("content_filter");
  });
});

describe("R2-X8 reasoning + cache-creation usage", () => {
  it("both detail blocks round-trip", () => {
    const { state } = feedToChat([
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 8, output_tokens_details: { reasoning_tokens: 4 }, input_tokens_details: { cached_tokens: 3 } } } },
    ]);
    expect(state.usage.prompt_tokens_details).toMatchObject({ cached_tokens: 3 });
    expect(state.usage.completion_tokens_details).toMatchObject({ reasoning_tokens: 4 });
  });
});

describe("R2-X9 flush on unstarted stream", () => {
  it("null-flush on fresh state yields one stop chunk", () => {
    const out = openaiResponsesToOpenAIResponse(null, freshChat());
    expect(out.choices[0].finish_reason).toBe("stop");
  });
});

describe("R2-X10 thinking + tool same chunk", () => {
  it("emits both reasoning delta and function_call item", () => {
    const { events } = feedToResponses([
      ocChunk({ content: "<think>hmm" }),
      ocChunk({ content: "still thinking", tool_calls: [{ index: 0, id: "c1", function: { name: "A", arguments: "{}" } }] }),
    ]);
    expect(events.some((e) => e.event === "response.reasoning_summary_text.delta")).toBe(true);
    expect(addedOf(events).some((e) => e.data.item?.type === "function_call")).toBe(true);
  });
});

describe("R2-X6 scope: chat -> responses events carry no role field", () => {
  it("output_text.delta / function_call items match the Responses wire shape (no role)", () => {
    const { events } = feedToResponses([
      ocChunk({ content: "hi" }),
      ocChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] }),
    ]);
    const deltas = events.filter((e) => e.event === "response.output_text.delta");
    expect(deltas[0].data.role).toBeUndefined();
    const added = events.find((e) => e.event === "response.output_item.added" && e.data.item.type === "function_call");
    expect(added.data.item.role).toBeUndefined();
  });
});

describe("R2-X5 real Responses item ids (item.id is not derived from call_id)", () => {
  it("argument deltas route by the item.id recorded at output_item.added", () => {
    const { chunks } = feedToChat([
      { type: "response.output_item.added", item: { id: "fc_68a1", type: "function_call", call_id: "call_A", name: "fa" } },
      { type: "response.output_item.added", item: { id: "fc_68b2", type: "function_call", call_id: "call_B", name: "fb" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_68a1", delta: '{"x":1}' },
      { type: "response.function_call_arguments.delta", item_id: "fc_68b2", delta: '{"y":2}' },
      { type: "response.completed", response: {} },
    ]);
    const tools = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
    const byId = Object.fromEntries(tools.filter((t) => t.id).map((t) => [t.id, t.index]));
    expect(byId.call_A).toBe(0);
    expect(byId.call_B).toBe(1);
    const argDeltas = tools.filter((t) => !t.id);
    expect(argDeltas.find((t) => t.function.arguments === '{"x":1}').index).toBe(0);
    expect(argDeltas.find((t) => t.function.arguments === '{"y":2}').index).toBe(1);
    // An item_id that matches nothing must not allocate a phantom index.
    expect(Math.max(...tools.map((t) => t.index))).toBe(1);
  });
});
