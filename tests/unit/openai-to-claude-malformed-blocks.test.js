import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

/**
 * Regression: the OpenAI→Claude translator dereferenced client-controlled
 * fields without guarding them:
 *   - `tc.function.name` on a tool_call whose `function` object was absent
 *   - `part.image_url.url` on an image_url part whose `image_url` was absent
 * Either threw a TypeError, surfacing as a 500 on an otherwise recoverable
 * malformed request. They should be skipped instead.
 */
describe("openaiToClaudeRequest malformed content blocks", () => {
  it("skips a tool_call missing its function object without throwing", () => {
    expect(() =>
      openaiToClaudeRequest("claude-x", {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "bad", type: "function" }, // no .function
              { id: "ok", type: "function", function: { name: "real", arguments: "{}" } },
            ],
          },
        ],
      }, true)
    ).not.toThrow();
  });

  it("keeps a well-formed tool_call alongside a malformed one", () => {
    const out = openaiToClaudeRequest("claude-x", {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "bad", type: "function" },
            { id: "ok", type: "function", function: { name: "real", arguments: "{}" } },
          ],
        },
      ],
    }, true);
    const dumped = JSON.stringify(out.messages);
    expect(dumped).toContain("real");
    expect(dumped).not.toContain('"id":"bad"');
  });

  it("skips an image_url part missing its image_url object without throwing", () => {
    expect(() =>
      openaiToClaudeRequest("claude-x", {
        messages: [{ role: "user", content: [{ type: "image_url" }, { type: "text", text: "hi" }] }],
      }, true)
    ).not.toThrow();
  });
});
