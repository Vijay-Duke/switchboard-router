/**
 * Regression tests for gatekeeper-approved fixes from waves 1–5.
 */
import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";
import { ensureToolCallIds } from "../../open-sse/translator/concerns/toolCall.js";
import { parseGrepLine } from "../../open-sse/rtk/autodetect.js";
import { grep } from "../../open-sse/rtk/filters/grep.js";
import { gitStatus } from "../../open-sse/rtk/filters/gitStatus.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";

describe("wave1: checkFallbackError non-retryable 400", () => {
  it("does not fallback on bare 400", () => {
    const r = checkFallbackError(400, "invalid tool type");
    expect(r.shouldFallback).toBe(false);
  });
  it("still fallbacks on 429", () => {
    const r = checkFallbackError(429, "rate limit");
    expect(r.shouldFallback).toBe(true);
  });
  it("still fallbacks on 503", () => {
    const r = checkFallbackError(503, "unavailable");
    expect(r.shouldFallback).toBe(true);
  });
});

describe("wave1: filterUsageForFormat OpenAI shape", () => {
  it("keeps prompt_tokens when filtering as openai", () => {
    const u = filterUsageForFormat(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      FORMATS.OPENAI
    );
    expect(u.prompt_tokens).toBe(10);
    expect(u.completion_tokens).toBe(5);
  });
});

describe("wave2: DeepSeek alias wire thinking", () => {
  it("sets body.thinking not extra_body for -max", () => {
    const out = injectReasoningContent({
      provider: "deepseek",
      model: "deepseek-v4-pro-max",
      body: { messages: [{ role: "user", content: "hi" }], model: "deepseek-v4-pro-max" },
    });
    expect(out.model).toBe("deepseek-v4-pro");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.extra_body?.thinking).toBeUndefined();
  });
  it("sets thinking disabled for -none", () => {
    const out = injectReasoningContent({
      provider: "deepseek",
      model: "deepseek-v4-pro-none",
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(out.thinking).toEqual({ type: "disabled" });
  });
});

describe("wave2: thinking signature survives openai pivot", () => {
  it("carries signature back to claude thinking block", () => {
    const openai = claudeToOpenAIRequest("m", {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", signature: "sig-abc-123-valid-looking" },
          { type: "text", text: "hi" },
        ],
      }],
    }, true);
    const asst = openai.messages.find((m) => m.role === "assistant");
    expect(asst.reasoning_content).toBe("plan");
    expect(asst.reasoning_signature).toBe("sig-abc-123-valid-looking");

    const back = openaiToClaudeRequest("claude-sonnet", {
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "hi", reasoning_content: "plan", reasoning_signature: "sig-abc-123-valid-looking" },
      ],
    }, true);
    const a2 = back.messages.find((m) => m.role === "assistant");
    const think = a2.content.find((b) => b.type === "thinking");
    expect(think.thinking).toBe("plan");
    expect(think.signature).toBe("sig-abc-123-valid-looking");
  });
});

describe("wave5: ensureToolCallIds remaps tool messages", () => {
  it("keeps tool_call_id paired after sanitizing bad chars", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: "call/bad:id!",
            type: "function",
            function: { name: "x", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call/bad:id!", content: "ok" },
      ],
    };
    ensureToolCallIds(body);
    expect(body.messages[0].tool_calls[0].id).toBe(body.messages[1].tool_call_id);
    expect(/^[a-zA-Z0-9_-]+$/.test(body.messages[0].tool_calls[0].id)).toBe(true);
  });
});

describe("wave4: Windows grep paths", () => {
  it("parses C:\\path:line:content", () => {
    const p = parseGrepLine("C:\\Users\\me\\a.js:10:const x = 1");
    expect(p).toBeTruthy();
    expect(p.file).toBe("C:\\Users\\me\\a.js");
    expect(p.lineNum).toBe("10");
  });
  it("compacts windows grep dump", () => {
    const input = [
      "C:\\Users\\me\\a.js:10:const x = 1",
      "C:\\Users\\me\\a.js:20:const y = 2",
      "C:\\Users\\me\\b.js:5:hi",
    ].join("\n");
    const out = grep(input);
    expect(out).toContain("3 matches");
    expect(out).toContain("a.js");
  });
});

describe("wave4: gitStatus long-form untracked", () => {
  it("counts untracked section bare paths", () => {
    const input = [
      "On branch main",
      "Untracked files:",
      "  (use \"git add\" to include)",
      "\tnotes.txt",
      "\tscratch.md",
    ].join("\n");
    const out = gitStatus(input);
    expect(out).toContain("Untracked");
    expect(out).toMatch(/notes\.txt|2 files/);
  });
});
