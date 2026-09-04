/** Round-2 request-translator findings X50–X54, X68 (openai-to-cursor). */
import { describe, it, expect } from "vitest";
import { openaiToCursorRequest } from "../../open-sse/translator/request/openai-to-cursor.js";

const run = (body) => openaiToCursorRequest("m", body, true);

describe("X50 tool_choice survives", () => {
  it.each([["none"], ["auto"], ["required"]])("%s survives", (choice) => {
    expect(run({ messages: [{ role: "user", content: "hi" }], tool_choice: choice }).tool_choice)
      .toBe(choice);
  });
  it("forced tool survives", () => {
    const tc = { type: "function", function: { name: "f" } };
    expect(run({ messages: [{ role: "user", content: "hi" }], tool_choice: tc }).tool_choice)
      .toEqual(tc);
  });
});

describe("X51 id-less tool_use gets a fallback id", () => {
  it("turn survives with a generated id", () => {
    const out = run({
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", name: "f", input: { a: 1 } }],
      }],
    });
    const asst = out.messages.find((m) => m.role === "assistant");
    expect(asst).toBeDefined();
    expect(asst.tool_calls).toHaveLength(1);
    expect(typeof asst.tool_calls[0].id).toBe("string");
    expect(asst.tool_calls[0].id.length).toBeGreaterThan(0);
  });
});

describe("X52 consecutive users merge", () => {
  it("[system, system, user] yields one user message", () => {
    const out = run({
      messages: [
        { role: "system", content: "s1" },
        { role: "system", content: "s2" },
        { role: "user", content: "hi" },
      ],
    });
    const users = out.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].content).toContain("s1");
    expect(users[0].content).toContain("s2");
    expect(users[0].content).toContain("hi");
  });
});

describe("X53 tool-result images carried", () => {
  it("text + image tool result keeps both", () => {
    const out = run({
      messages: [
        {
          role: "assistant", content: "x",
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: [
            { type: "text", text: "shot" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
    });
    const toolMsg = out.messages.find((m) => m.role === "user");
    const parts = Array.isArray(toolMsg.content) ? toolMsg.content : [{ text: toolMsg.content }];
    expect(parts.length).toBe(2);
    expect(JSON.stringify(parts)).toContain("image_url");
  });
});

describe("X54 max_output_tokens", () => {
  it.each([
    [{ max_tokens: 1 }, 1],
    [{ max_completion_tokens: 2 }, 2],
    [{ max_output_tokens: 3 }, 3],
  ])("%j → %i", (extra, expected) => {
    expect(run({ messages: [{ role: "user", content: "hi" }], ...extra }).max_tokens).toBe(expected);
  });
});

describe("X68 parallel_tool_calls false never trims cursor history", () => {
  it("both calls survive", () => {
    const out = run({
      messages: [{
        role: "assistant",
        content: "x",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      }],
      parallel_tool_calls: false,
    });
    expect(out.messages[0].tool_calls).toHaveLength(2);
  });
});
