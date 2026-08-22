/**
 * Unit tests for anchorClaudeCache (port of upstream 7e5f5a88):
 *  - last system block and last tool pinned at ttl 1h, earlier ones cleared
 *  - last assistant turn anchored at 5m; falls back to the final message
 *    when no assistant turn exists yet
 *  - thinking blocks never receive cache_control
 *  - normalizeClaudePassthrough folds mid-conversation system messages into
 *    the neighbouring user turn without mutating the input objects
 */

import { describe, it, expect } from "vitest";
import { anchorClaudeCache, normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { ROLE, CLAUDE_BLOCK } from "../../open-sse/translator/schema/index.js";

describe("anchorClaudeCache", () => {
  it("pins the last system block at 1h and clears earlier markers", () => {
    const body = {
      system: [
        { type: "text", text: "intro", cache_control: { type: "ephemeral" } },
        { type: "text", text: "core" },
      ],
    };
    anchorClaudeCache(body);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("pins only the last tool at 1h", () => {
    const body = {
      tools: [
        { name: "read" },
        { name: "write", cache_control: { type: "ephemeral" } },
        { name: "bash" },
      ],
    };
    anchorClaudeCache(body);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("anchors the last assistant turn at 5m and drops stale client markers", () => {
    const body = {
      messages: [
        { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: "hi", cache_control: { type: "ephemeral" } }] },
        { role: ROLE.ASSISTANT, content: [{ type: CLAUDE_BLOCK.TEXT, text: "hello" }] },
        { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: "again" }] },
      ],
    };
    anchorClaudeCache(body);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[2].content[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to anchoring the final message when no assistant turn exists", () => {
    const body = {
      messages: [
        { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: "first prompt only" }] },
      ],
    };
    anchorClaudeCache(body);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips thinking blocks when picking the anchor block", () => {
    const body = {
      messages: [
        {
          role: ROLE.ASSISTANT,
          content: [
            { type: CLAUDE_BLOCK.THINKING, thinking: "hmm", signature: "sig" },
            { type: CLAUDE_BLOCK.TEXT, text: "answer" },
          ],
        },
      ],
    };
    anchorClaudeCache(body);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles a body without system/tools/messages", () => {
    expect(() => anchorClaudeCache({})).not.toThrow();
    expect(anchorClaudeCache(null)).toBeNull();
  });
});

describe("normalizeClaudePassthrough — mid-conversation system folding", () => {
  it("folds a system message into the preceding user turn", () => {
    const userBlock = { type: CLAUDE_BLOCK.TEXT, text: "question" };
    const input = {
      messages: [
        { role: ROLE.USER, content: [userBlock] },
        { role: ROLE.SYSTEM, content: "mid-talk reminder" },
        { role: ROLE.ASSISTANT, content: [{ type: CLAUDE_BLOCK.TEXT, text: "ok" }] },
      ],
    };
    const out = normalizeClaudePassthrough(input);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0].role).toBe(ROLE.USER);
    expect(out.messages[0].content).toHaveLength(2);
    expect(out.messages[0].content[1]).toEqual({ type: CLAUDE_BLOCK.TEXT, text: "mid-talk reminder" });
    // No hoisting into body.system
    expect(out.system).toBeUndefined();
  });

  it("does not mutate the original message objects (copy-on-write)", () => {
    const originalUser = { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: "q" }] };
    const input = {
      messages: [
        originalUser,
        { role: ROLE.SYSTEM, content: "note" },
      ],
    };
    normalizeClaudePassthrough(input);
    expect(originalUser.content).toHaveLength(1);
    expect(input.messages[0] !== originalUser || originalUser.content.length === 1).toBe(true);
    // The folded copy is a new object even if identity were reused
    const folded = input.messages.find(m => m.role === ROLE.USER && m.content.length === 2);
    expect(folded?.content?.[1]?.text).toBe("note");
  });

  it("creates a user turn for a leading system message", () => {
    const input = {
      messages: [
        { role: ROLE.SYSTEM, content: "preamble" },
        { role: ROLE.USER, content: "hello" },
      ],
    };
    const out = normalizeClaudePassthrough(input);
    expect(out.messages[0].role).toBe(ROLE.USER);
    expect(out.messages[0].content[0].text).toBe("preamble");
    expect(out.messages[1].role).toBe(ROLE.USER);
  });
});
