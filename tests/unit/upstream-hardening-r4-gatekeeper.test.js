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

describe("openai→claude opens tool block without id (scout P0)", () => {
  it("opens tool on name-only first delta", () => {
    const state = { toolCalls: new Map(), nextBlockIndex: 0 };
    const events = openaiToClaudeResponse({
      id: "c1",
      model: "m",
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { name: "lookup", arguments: "" } }],
        },
      }],
    }, state);
    expect(events).toBeTruthy();
    const start = events.find((e) => e.type === "content_block_start");
    expect(start).toBeTruthy();
    expect(start.content_block.name).toBe("lookup");
    expect(start.content_block.id).toBeTruthy();
  });
});
