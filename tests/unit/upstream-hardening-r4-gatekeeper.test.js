/**
 * Gatekeeper-approved fixes from the 12-scout fleet.
 */
import { describe, it, expect } from "vitest";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("OAuth cloaking with type:custom tools (scout P0 / R3 regression)", () => {
  it("renames client tools that have type custom", () => {
    const body = {
      tools: [
        { type: "custom", name: "Execute", description: "run", input_schema: { type: "object", properties: {} } },
        { type: "web_search_20250305", name: "web_search", max_uses: 1 },
      ],
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Execute", input: {} }] },
      ],
    };
    const { body: cloaked, toolNameMap } = cloakClaudeTools(body);
    expect(toolNameMap).toBeTruthy();
    expect(toolNameMap.has("Execute_cc") || [...toolNameMap.keys()].some((k) => k.startsWith("Execute"))).toBe(true);
    const client = cloaked.tools.find((t) => t.name.startsWith("Execute"));
    expect(client).toBeTruthy();
    expect(client.name).not.toBe("Execute");
    // server tool unchanged
    expect(cloaked.tools.some((t) => t.type === "web_search_20250305")).toBe(true);
    // history renamed
    const toolUse = cloaked.messages[0].content[0];
    expect(toolUse.name).not.toBe("Execute");
  });
});

describe("tool_choice none maps to Claude none (scout P0)", () => {
  it("preserves none", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      tool_choice: "none",
    }, true);
    expect(out.tool_choice).toEqual({ type: "none" });
  });
});

describe("openai→claude preserves named tools with missing or late IDs (scout P0)", () => {
  const firstChunk = {
    id: "c1",
    model: "m",
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "" } }] } }],
  };
  const finish = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };

  it("assigns a fallback ID at finish when the upstream never supplies one", () => {
    const state = { toolCalls: new Map(), nextBlockIndex: 0 };
    const initial = openaiToClaudeResponse(firstChunk, state);
    expect(initial).toBeTruthy();
    expect(initial.some(event => event.content_block?.type === "tool_use")).toBe(false);

    const completed = openaiToClaudeResponse(finish, state);
    const start = completed.find(event => event.content_block?.type === "tool_use");
    expect(start.content_block).toEqual({
      type: "tool_use", name: "lookup", id: expect.stringMatching(/^toolu_[a-zA-Z0-9_-]+$/), input: {},
    });
    expect(completed).toContainEqual({ type: "content_block_stop", index: start.index });
    expect(completed.at(-1)).toEqual({ type: "message_stop" });
  });

  it("retains a late real ID on the wire instead of prematurely substituting one", () => {
    const state = { toolCalls: new Map(), nextBlockIndex: 0 };
    openaiToClaudeResponse(firstChunk, state);
    const identified = openaiToClaudeResponse({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_lookup", function: { arguments: "{}" } }] } }],
    }, state);
    const start = identified.find(event => event.content_block?.type === "tool_use");
    expect(start.content_block).toEqual({ type: "tool_use", name: "lookup", id: "call_lookup", input: {} });
    const completed = openaiToClaudeResponse(finish, state);
    expect(completed.filter(event => event.delta?.type === "input_json_delta").map(event => event.delta.partial_json)).toEqual(["{}"]);
    expect(completed).toContainEqual({ type: "content_block_stop", index: start.index });
  });
});
