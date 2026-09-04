/** Round-2 request-translator findings X42–X49, X68 (kiro paths). */
import { describe, it, expect } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const TOOLS = [{
  type: "function",
  function: { name: "w", description: "weather", parameters: { type: "object", properties: {} } },
}];
const CLAUDE_TOOLS = [{
  name: "w", description: "weather", input_schema: { type: "object", properties: {} },
}];

const currentTools = (payload) =>
  payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? null;

const assistantFirstOpenAI = [
  { role: "assistant", content: "prefill lead" },
  { role: "user", content: "go" },
  { role: "assistant", content: "working" },
  { role: "user", content: "continue" },
];
const userFirstOpenAI = [
  { role: "user", content: "go" },
  { role: "assistant", content: "working" },
  { role: "user", content: "continue" },
];
const assistantFirstClaude = [
  { role: "assistant", content: "prefill lead" },
  { role: "user", content: "go" },
  { role: "assistant", content: "working" },
  { role: "user", content: "continue" },
];

describe("X42/X46 assistant-first tools", () => {
  it("openai assistant-first multi-turn keeps tools on current message", () => {
    const out = openaiToKiroRequest("m", { messages: assistantFirstOpenAI, tools: TOOLS }, true, {});
    expect(currentTools(out)).toHaveLength(1);
  });
  it("openai user-first multi-turn keeps tools (control)", () => {
    const out = openaiToKiroRequest("m", { messages: userFirstOpenAI, tools: TOOLS }, true, {});
    expect(currentTools(out)).toHaveLength(1);
  });
  it("openai single-turn keeps tools", () => {
    const out = openaiToKiroRequest("m", {
      messages: [{ role: "user", content: "hi" }], tools: TOOLS,
    }, true, {});
    expect(currentTools(out)).toHaveLength(1);
  });
  it("claude assistant-first multi-turn keeps tools on current message", () => {
    const out = claudeToKiroRequest("m", { messages: assistantFirstClaude, tools: CLAUDE_TOOLS }, true, {});
    expect(currentTools(out)).toHaveLength(1);
  });
});

describe("X47 stable conversationId", () => {
  const creds = (connectionId) => ({ connectionId });
  it("identical consecutive calls share conversationId per connection", () => {
    const body = () => ({ messages: [{ role: "user", content: "hi" }], tools: CLAUDE_TOOLS });
    const a = claudeToKiroRequest("m", body(), true, creds("conn-r2a"));
    const b = claudeToKiroRequest("m", body(), true, creds("conn-r2a"));
    expect(a.conversationState.conversationId).toBe(b.conversationState.conversationId);
  });
  it("distinct connections differ", () => {
    const body = () => ({ messages: [{ role: "user", content: "hi" }], tools: CLAUDE_TOOLS });
    const a = claudeToKiroRequest("m", body(), true, creds("conn-r2b"));
    const b = claudeToKiroRequest("m", body(), true, creds("conn-r2c"));
    expect(a.conversationState.conversationId).not.toBe(b.conversationState.conversationId);
  });
});

describe("X48 system representation parity", () => {
  it("both translators use <instructions> text, no native field", () => {
    const open = openaiToKiroRequest("m", {
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    }, true, {});
    const claude = claudeToKiroRequest("m", {
      system: "be brief", messages: [{ role: "user", content: "hi" }],
    }, true, {});
    for (const [name, payload] of [["openai", open], ["claude", claude]]) {
      const uim = payload.conversationState.currentMessage.userInputMessage;
      expect(uim.systemInstruction, `${name} native field absent`).toBeUndefined();
      expect(uim.content, `${name} instructions fold`).toContain("<instructions>\nbe brief\n</instructions>");
    }
  });
});

describe("X43 claude URL images", () => {
  it("base64 + URL claude images both survive", () => {
    const out = openaiToKiroRequest("m", {
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "image", source: { type: "url", url: "https://x/i.png" } },
        ],
      }],
    }, true, {});
    const uim = out.conversationState.currentMessage.userInputMessage;
    expect(uim.images).toHaveLength(1);
    expect(uim.content).toContain("[Image: https://x/i.png]");
  });
});

describe("X44 kiro JSON/stop instructions", () => {
  it("JSON mode becomes an instruction", () => {
    const out = openaiToKiroRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    }, true, {});
    expect(out.conversationState.currentMessage.userInputMessage.content).toContain("valid JSON");
  });
  it("stop becomes an instruction", () => {
    const out = openaiToKiroRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      stop: ["END"],
    }, true, {});
    expect(out.conversationState.currentMessage.userInputMessage.content).toContain("END");
  });
});

describe("X45 stub placeholder", () => {
  it("empty stub tool message maps to non-empty content", () => {
    const out = openaiToKiroRequest("m", {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant", content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "w", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "" },
        { role: "user", content: "go" },
      ],
      tools: TOOLS,
    }, true, {});
    const text = JSON.stringify(out.conversationState);
    expect(text).toContain("No response received");
  });
});

describe("X49 flatten keeps thinking", () => {
  it("assistant thinking survives the no-tools flatten", () => {
    const out = claudeToKiroRequest("m", {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought" },
          { type: "tool_use", id: "t1", name: "f", input: {} },
        ],
      }, { role: "user", content: "go" }],
    }, true, {});
    expect(JSON.stringify(out.conversationState)).toContain("deep thought");
  });
});

describe("X68 parallel_tool_calls false never trims kiro history", () => {
  it("both toolUses survive", () => {
    const out = openaiToKiroRequest("m", {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant", content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "user", content: "go" },
      ],
      tools: [...TOOLS, { type: "function", function: { name: "b", description: "b", parameters: { type: "object", properties: {} } } }],
      parallel_tool_calls: false,
    }, true, {});
    const text = JSON.stringify(out.conversationState.history);
    expect(text).toContain('"name":"a","input"');
    expect(text).toContain('"name":"b","input"');
  });
});
