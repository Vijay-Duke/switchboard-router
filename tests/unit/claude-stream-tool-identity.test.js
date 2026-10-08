import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const chunk = (delta, finishReason = null) => ({ id: "chatcmpl-tool-identity", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] });
const toolChunk = (index, fields) => chunk({ tool_calls: [{ index, ...fields }] });
const finish = () => chunk({}, "tool_calls");
const feed = (chunks) => {
  const state = { toolCalls: new Map() };
  return chunks.flatMap(value => openaiToClaudeResponse(value, state) || []);
};

// Reconstruct what a Claude client actually receives. Later mutations of
// translator state cannot repair the name/id already sent in a block start.
const wireTools = (events) => {
  const blocks = new Map();
  for (const event of events) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      blocks.set(event.index, { ...structuredClone(event.content_block), json: "" });
    } else if (event.delta?.type === "input_json_delta") {
      blocks.get(event.index).json += event.delta.partial_json;
    } else if (event.type === "content_block_stop" && blocks.has(event.index)) {
      const block = blocks.get(event.index);
      if (block.json) block.input = JSON.parse(block.json);
    }
  }
  return [...blocks.values()].map(({ json: _json, ...block }) => block);
};

describe("Claude streamed tool identity", () => {
  it("waits for the name after an ID-only chunk instead of sending a nameless call", () => {
    const events = feed([
      toolChunk(0, { id: "call_a", function: {} }),
      toolChunk(0, { function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }),
      finish(),
    ]);
    expect(wireTools(events)).toEqual([{ type: "tool_use", id: "call_a", name: "Read", input: { file_path: "a.txt" } }]);
  });

  it("waits for an ID after a name-only chunk, keeping the upstream ID on the wire", () => {
    const events = feed([
      toolChunk(0, { function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }),
      toolChunk(0, { id: "call_a" }),
      finish(),
    ]);
    expect(wireTools(events)[0]).toMatchObject({ id: "call_a", name: "Read", input: { file_path: "a.txt" } });
  });

  it("preserves arguments that arrive before both name and ID", () => {
    const events = feed([
      toolChunk(0, { function: { arguments: '{"file_path":' } }),
      toolChunk(0, { id: "call_a", function: { arguments: '"a.txt"}' } }),
      toolChunk(0, { function: { name: "Read" } }),
      finish(),
    ]);
    expect(wireTools(events)[0]).toMatchObject({ id: "call_a", name: "Read", input: { file_path: "a.txt" } });
  });

  it("keeps independently interleaved identities and argument buffers paired", () => {
    const events = feed([
      toolChunk(0, { id: "call_read" }),
      toolChunk(1, { function: { name: "Bash", arguments: '{"command":"pwd"}' } }),
      toolChunk(0, { function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }),
      toolChunk(1, { id: "call_bash" }),
      finish(),
    ]);
    expect(wireTools(events)).toEqual([
      { type: "tool_use", id: "call_read", name: "Read", input: { file_path: "a.txt" } },
      { type: "tool_use", id: "call_bash", name: "Bash", input: { command: "pwd" } },
    ]);
  });

  it("generates only a missing ID at finish for a genuinely named upstream call", () => {
    const events = feed([toolChunk(0, { function: { name: "Bash", arguments: '{"command":"pwd"}' } }), finish()]);
    expect(wireTools(events)[0]).toMatchObject({ id: expect.stringMatching(/^toolu_/), name: "Bash", input: { command: "pwd" } });
  });

  it.each([finish(), null])("surfaces missing tool names at completion instead of inventing an executable call", (terminal) => {
    const events = feed([toolChunk(0, { id: "call_a", function: { arguments: "{}" } }), terminal]);
    expect(wireTools(events)).toEqual([]);
    expect(events).toContainEqual({ type: "error", error: { type: "api_error", message: terminal ? "Upstream tool call ended without a tool name." : "Upstream stream closed before a finish reason." } });
    expect(events.some(event => event.type === "message_stop")).toBe(false);
  });

  it("streams ordinary text while waiting for a partial tool identity", () => {
    const state = { toolCalls: new Map() };
    const events = openaiToClaudeResponse(chunk({ content: "Checking the file", tool_calls: [{ index: 0, id: "call_a" }] }), state);
    expect(events).toContainEqual(expect.objectContaining({ delta: { type: "text_delta", text: "Checking the file" } }));
    expect(events.some(event => event.content_block?.type === "tool_use")).toBe(false);
  });
});
