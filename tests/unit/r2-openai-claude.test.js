/** Round-2 request-translator findings X23–X31, X68 (openai-to-claude). */
import { describe, it, expect } from "vitest";
import {
  openaiToClaudeRequest,
  openaiToClaudeRequestForAntigravity,
} from "../../open-sse/translator/request/openai-to-claude.js";

const user = (content) => ({ role: "user", content });

describe("X23 developer role lands in system", () => {
  it("developer-only", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }],
    }, true);
    expect(JSON.stringify(out.system)).toContain("be brief");
    expect(out.messages).toHaveLength(1);
  });
  it("mixed developer + system concatenate", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [
        { role: "system", content: "sys" },
        { role: "developer", content: "dev" },
        { role: "user", content: "hi" },
      ],
    }, true);
    const text = JSON.stringify(out.system);
    expect(text).toContain("sys");
    expect(text).toContain("dev");
  });
});

describe("X24 top-level is_error", () => {
  it.each([[true, true], [false, false]])("is_error %s round-trips", (input, expected) => {
    const out = openaiToClaudeRequest("m", {
      messages: [
        { role: "assistant", content: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "boom", is_error: input },
      ],
    }, true);
    const tr = out.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(tr.is_error).toBe(expected);
  });
  it("absent stays absent", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [
        { role: "assistant", content: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    }, true);
    const tr = out.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect("is_error" in tr).toBe(false);
  });
});

describe("X25 audio degrades to note", () => {
  it("audio-only turn yields a text note, not messages []", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAA", format: "wav" } }] }],
    }, true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).toContain("audio omitted");
  });
  it("audio + text keeps the text", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hear this" },
          { type: "input_audio", input_audio: { data: "AAA", format: "mp3" } },
        ],
      }],
    }, true);
    const text = JSON.stringify(out.messages);
    expect(text).toContain("hear this");
    expect(text).toContain("audio omitted");
  });
});

describe("X26 non-PDF files", () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  it("text file decodes to a text block", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [user([{ type: "file", file: { file_data: `data:text/plain;base64,${b64("hello file")}` } }])],
    }, true);
    expect(JSON.stringify(out.messages)).toContain("hello file");
  });
  it("unknown mime becomes an omitted note, not messages []", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [user([{ type: "file", file: { file_data: "data:video/mp4;base64,AAA" } }])],
    }, true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.messages)).toContain("file omitted");
  });
  it("pdf still becomes a document block", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [user([{ type: "file", file: { file_data: "data:application/pdf;base64,AAA" } }])],
    }, true);
    const doc = out.messages.flatMap((m) => m.content).find((b) => b.type === "document");
    expect(doc).toBeDefined();
  });
});

describe("X27 stop mapping", () => {
  it("string stop maps", () => {
    const out = openaiToClaudeRequest("m", { messages: [user("hi")], stop: "END" }, true);
    expect(out.stop_sequences).toEqual(["END"]);
  });
  it("array stop maps", () => {
    const out = openaiToClaudeRequest("m", { messages: [user("hi")], stop: ["A", "B"] }, true);
    expect(out.stop_sequences).toEqual(["A", "B"]);
  });
  it("absent stays absent", () => {
    const out = openaiToClaudeRequest("m", { messages: [user("hi")] }, true);
    expect(out.stop_sequences).toBeUndefined();
  });
});

describe("X28 assistant images", () => {
  it("assistant image_url round-trips to a Claude image block", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [{
        role: "assistant",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
      }],
    }, true);
    expect(out.messages.length).toBeGreaterThan(0);
    const img = out.messages.flatMap((m) => m.content).find((b) => b.type === "image");
    expect(img).toBeDefined();
  });
});

describe("X29 tool array conversion", () => {
  it("text + image tool content converts (no raw image_url leak)", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [
        { role: "assistant", content: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "shot" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
    }, true);
    const tr = out.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(tr).toBeDefined();
    expect(JSON.stringify(tr.content)).not.toContain("image_url");
  });
});

describe("X30 top_p / top_k", () => {
  it("values survive; absent stays absent", () => {
    const out = openaiToClaudeRequest("m", {
      messages: [user("hi")], top_p: 0.5, top_k: 10,
    }, true);
    expect(out.top_p).toBe(0.5);
    expect(out.top_k).toBe(10);
    const bare = openaiToClaudeRequest("m", { messages: [user("hi")] }, true);
    expect(bare.top_p).toBeUndefined();
    expect(bare.top_k).toBeUndefined();
  });
});

describe("X31 antigravity system filter", () => {
  it("user text quoting the phrase survives; exact injected prompt is removed", async () => {
    const { CLAUDE_SYSTEM_PROMPT } = await import("../../open-sse/config/appConstants.js");
    const out = openaiToClaudeRequestForAntigravity("m", {
      messages: [
        { role: "system", content: "Reminder: You are Claude Code is a phrase I quote" },
        { role: "user", content: "hi" },
      ],
    }, true);
    expect(JSON.stringify(out.system)).toContain("You are Claude Code is a phrase I quote");

    const exact = openaiToClaudeRequestForAntigravity("m", {
      messages: [
        { role: "system", content: CLAUDE_SYSTEM_PROMPT },
        { role: "user", content: "hi" },
      ],
    }, true);
    expect(exact.system).toBeUndefined();
  });
});

// X68 (gate reversal): map to Claude's native disable_parallel_tool_use; never
// rewrite history.
describe("X68 parallel_tool_calls false → disable_parallel_tool_use", () => {
  const tools = [{ type: "function", function: { name: "a", parameters: { type: "object", properties: {} } } }];
  const hist = [{
    role: "assistant",
    content: "x",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
    ],
  }];
  it("history keeps both tool_use blocks", () => {
    const out = openaiToClaudeRequest("m", { messages: hist, tools, parallel_tool_calls: false }, true);
    const uses = out.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use");
    expect(uses).toHaveLength(2);
  });
  it("sets disable_parallel_tool_use on auto (unset) and forced tool_choice", () => {
    const auto = openaiToClaudeRequest("m", { messages: hist, tools, parallel_tool_calls: false }, true);
    expect(auto.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    const req = openaiToClaudeRequest("m", { messages: hist, tools, tool_choice: "required", parallel_tool_calls: false }, true);
    expect(req.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
  });
  it("leaves none / true / no-tools untouched", () => {
    expect(openaiToClaudeRequest("m", { messages: hist, tools, tool_choice: "none", parallel_tool_calls: false }, true).tool_choice)
      .toEqual({ type: "none" });
    expect(openaiToClaudeRequest("m", { messages: hist, tools, parallel_tool_calls: true }, true).tool_choice).toBeUndefined();
    expect(openaiToClaudeRequest("m", { messages: hist, parallel_tool_calls: false }, true).tool_choice).toBeUndefined();
  });
});
