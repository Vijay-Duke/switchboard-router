/**
 * Round-2 regression tests for high-impact fixes ported from decolua/9router.
 */
import { describe, it, expect } from "vitest";
import { stripOrphanedToolResults } from "../../open-sse/translator/concerns/toolCall.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { find } from "../../open-sse/rtk/filters/find.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

// Register translators
import "../../open-sse/translator/request/claude-to-openai.js";
import "../../open-sse/translator/request/openai-to-claude.js";
import "../../open-sse/translator/request/gemini-to-openai.js";
import "../../open-sse/translator/response/openai-to-gemini.js";
import "../../open-sse/translator/response/openai-to-antigravity.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { commandCodeToOpenAIResponse } from "../../open-sse/translator/response/commandcode-to-openai.js";

describe("stripOrphanedToolResults (#2298 / #2236)", () => {
  it("removes orphaned OpenAI tool messages", () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "call_missing", content: "stale" },
        { role: "user", content: "continue" },
      ],
    };
    expect(stripOrphanedToolResults(body)).toBe(1);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("keeps paired tool results", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_abc", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_abc", content: "ok" },
      ],
    };
    expect(stripOrphanedToolResults(body)).toBe(0);
    expect(body.messages).toHaveLength(2);
  });

  it("strips orphaned Anthropic tool_result blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_gone", content: "stale" },
            { type: "text", text: "hi" },
          ],
        },
      ],
    };
    expect(stripOrphanedToolResults(body)).toBe(1);
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].type).toBe("text");
  });

  it("strips orphaned Responses function_call_output", () => {
    const body = {
      input: [
        { type: "function_call_output", call_id: "c_missing", output: "x" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    };
    expect(stripOrphanedToolResults(body)).toBe(1);
    expect(body.input).toHaveLength(1);
  });
});

describe("Windows RTK find paths (#2448)", () => {
  const WIN = [
    "C:\\Users\\me\\project\\src\\a.js",
    "C:\\Users\\me\\project\\src\\b.js",
    "C:\\Users\\me\\project\\src\\c.js",
  ].join("\n");

  it("detects Windows drive-letter paths as find", () => {
    expect(autoDetectFilter(WIN)).toBe(find);
  });

  it("groups and normalizes Windows backslash paths", () => {
    const out = find(WIN);
    expect(out).toContain("3 files in 1 dirs");
    expect(out).toContain("C:/Users/me/project/src/");
    expect(out).not.toContain("\\");
  });
});

describe("reasoning history bridge (#2400 / PR#2401)", () => {
  it("Claude thinking → OpenAI reasoning_content → Claude thinking", () => {
    const claudeBody = {
      messages: [
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    };
    const openai = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, "m", claudeBody, true);
    const asst = openai.messages.find((m) => m.role === "assistant");
    expect(asst.reasoning_content).toBe("plan");
    expect(asst.content === "answer" || (Array.isArray(asst.content) && asst.content.some((p) => p.text === "answer"))).toBe(true);

    const back = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet", {
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "answer", reasoning_content: "plan" },
      ],
    }, true, {}, "anthropic");
    const a2 = back.messages.find((m) => m.role === "assistant");
    expect(a2.content[0].type).toBe("thinking");
    expect(a2.content[0].thinking).toBe("plan");
  });
});

describe("gemini co-located functionResponse (#2393 / PR#2394)", () => {
  it("preserves functionCall alongside functionResponse in same content", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "do two things" }] },
        { role: "model", parts: [{ functionCall: { id: "call_a", name: "search", args: { q: "x" } } }] },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "call_a", name: "search", response: { result: "found x" } } },
            { functionCall: { id: "call_b", name: "edit", args: { pattern: "y" } } },
          ],
        },
      ],
    };
    const out = translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "m", body, true);
    const json = JSON.stringify(out);
    expect(json).toContain("edit");
    expect(json).toContain("search");
    expect(json).toContain("found x");
  });
});

describe("openai → gemini streaming response (#2398 / PR#2399)", () => {
  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX])(
    "projects OpenAI chunks into candidates envelope for %s",
    (clientFormat) => {
      const state = initState(clientFormat);
      const chunks = [
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      const out = chunks.flatMap((c) => translateResponse(FORMATS.OPENAI, clientFormat, c, state) || []);
      expect(out.length).toBeGreaterThan(0);
      for (const item of out) {
        expect(item.object).not.toBe("chat.completion.chunk");
        expect(item.choices).toBeUndefined();
        expect(item.response?.candidates || item.candidates).toBeTruthy();
      }
    }
  );
});

describe("commandcode tool maps with Responses state (#2395)", () => {
  it("does not throw when state already has responseId from initState(OPENAI_RESPONSES)", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    // Simulate tool-call event — previously: state.toolIndexById.has throws
    expect(() => {
      commandCodeToOpenAIResponse(
        { type: "tool-call", toolCallId: "t1", toolName: "echo", input: { x: 1 } },
        state
      );
    }).not.toThrow();
    const out = commandCodeToOpenAIResponse(
      { type: "tool-call", toolCallId: "t1", toolName: "echo", input: { x: 1 } },
      state
    );
    // Second call with same id should be no-op (already registered) or first emits
    expect(Array.isArray(out) || out == null || typeof out === "object").toBe(true);
  });
});

describe("prepareClaudeRequest promotes system role in messages (#1600)", () => {
  it("moves role:system out of messages into body.system", () => {
    const body = {
      model: "claude-sonnet",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "hi" },
      ],
    };
    prepareClaudeRequest(body, "claude");
    expect(body.messages.every((m) => m.role !== "system")).toBe(true);
    const sysText = Array.isArray(body.system)
      ? body.system.map((b) => b.text).join("\n")
      : body.system;
    expect(sysText).toContain("Be helpful.");
  });
});

describe("gemini schema string property fix (#1600 / #1564)", () => {
  it("converts property: 'object' shorthand to proper schema", () => {
    const schema = {
      type: "object",
      properties: {
        meta: "object",
        name: "string",
      },
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.meta.type).toBe("object");
    expect(cleaned.properties.meta.properties).toBeTruthy();
    expect(cleaned.properties.name.type).toBe("string");
  });
});

describe("claude passthrough tool decloak (#2391 / PR#2392)", () => {
  async function runPassthrough(toolNameMap, chunks) {
    const stream = createPassthroughStreamWithLogger(
      "claude",
      null,
      toolNameMap,
      "claude-opus-4",
      "conn-1",
      {},
      null,
      "sk-ant-oat-test"
    );
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const readAll = (async () => {
      let out = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
      return out;
    })();
    for (const chunk of chunks) await writer.write(encoder.encode(chunk));
    await writer.close();
    return readAll;
  }

  it("decloaks cloaked tool_use name in content_block_start", async () => {
    const toolNameMap = new Map([["Execute_ide", "Execute"]]);
    const sseChunk = `data: ${JSON.stringify({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_01", name: "Execute_ide", input: {} },
    })}\n\n`;
    const output = await runPassthrough(toolNameMap, [sseChunk]);
    expect(output).not.toContain("Execute_ide");
    expect(output).toContain('"name":"Execute"');
  });
});
