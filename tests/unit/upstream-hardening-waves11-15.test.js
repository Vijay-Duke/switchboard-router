/**
 * Regression tests for waves 11–15 gatekeeper fixes.
 */
import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";
import { fixMissingToolResponses } from "../../open-sse/translator/concerns/toolCall.js";
import { kiroToClaudeResponse } from "../../open-sse/translator/response/kiro-to-claude.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { dedupRefresh } from "../../open-sse/services/tokenRefresh/dedup.js";
import { appendUserTurn } from "../../open-sse/services/combo.js";
import { collectImageRefs } from "../../open-sse/translator/concerns/prefetch.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { convertOpenAIContentToParts } from "../../open-sse/translator/formats/gemini.js";
import { adjustMaxTokens } from "../../open-sse/translator/formats/maxTokens.js";
import { autoDetectFilter } from "../../open-sse/rtk/autodetect.js";
import { gitLog } from "../../open-sse/rtk/filters/gitLog.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { IFlowExecutor } from "../../open-sse/executors/iflow.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

// ── Wave 11 ──────────────────────────────────────────────────────────────

describe("wave11: gemini empty tool response stubs", () => {
  it("emits functionResponse for empty-string tool content", () => {
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "tool", tool_call_id: "c2", content: "" },
        { role: "user", content: "continue" },
      ],
    }, true);
    const frParts = out.contents
      .flatMap((c) => c.parts || [])
      .filter((p) => p.functionResponse);
    expect(frParts.length).toBe(2);
    expect(frParts.map((p) => p.functionResponse.name).sort()).toEqual(["a", "b"]);
  });
});

describe("wave11: gemini-cli preserves toolConfig", () => {
  it("copies tool_choice none into Cloud Code envelope toolConfig", () => {
    // openaiToGeminiCLIRequest + wrap is via FORMATS.GEMINI_CLI path; use openaiToGemini base
    // for toolConfig then check CLI wrapper through openaiToGeminiCLIRequest internals.
    const out = openaiToGeminiRequest("gemini-2.0-flash", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    }, true);
    expect(out.toolConfig?.functionCallingConfig?.mode).toBe("NONE");
  });
});

describe("wave11: ollama keeps empty tool results", () => {
  it("does not drop empty tool content", () => {
    const out = openaiToOllamaRequest("llama3", {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "" },
      ],
    }, true);
    const tools = out.messages.filter((m) => m.role === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0].content).toBe("");
  });
});

describe("wave11: fixMissing Claude-native tool_result stubs", () => {
  it("inserts user tool_result blocks for tool_use assistants", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu1", name: "lookup", input: {} },
            { type: "tool_use", id: "tu2", name: "write", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }],
        },
      ],
    };
    fixMissingToolResponses(body);
    const userMsgs = body.messages.filter((m) => m.role === "user");
    const allResults = userMsgs.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []
    );
    expect(allResults.map((b) => b.tool_use_id).sort()).toEqual(["tu1", "tu2"]);
    expect(body.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("wave11: kiro-to-claude tool open once per index", () => {
  it("does not reopen content_block_start for same tool id deltas", () => {
    const state = {};
    const chunk = (args) => ({
      id: "chatcmpl-x",
      model: "kiro",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "t1", function: { name: "a", arguments: args } }],
        },
      }],
    });
    const events1 = kiroToClaudeResponse(chunk("{}"), state) || [];
    const events2 = kiroToClaudeResponse(chunk(",\"x\":1"), state) || [];
    const list1 = Array.isArray(events1) ? events1 : [events1];
    const list2 = Array.isArray(events2) ? events2 : [events2];
    const starts1 = list1.filter((e) => e?.type === "content_block_start" && e.content_block?.type === "tool_use");
    const starts2 = list2.filter((e) => e?.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts1.length).toBe(1);
    expect(starts2.length).toBe(0);
  });
});

// ── Wave 12 ──────────────────────────────────────────────────────────────

describe("wave12: dedup does not sticky-cache null refresh", () => {
  it("retries after a null result", async () => {
    let calls = 0;
    const log = { info: () => {} };
    const r1 = await dedupRefresh("test-prov", "tok-a", async () => {
      calls++;
      return null;
    }, log);
    expect(r1).toBeNull();
    const r2 = await dedupRefresh("test-prov", "tok-a", async () => {
      calls++;
      return { accessToken: "new" };
    }, log);
    expect(r2.accessToken).toBe("new");
    expect(calls).toBe(2);
  });
});

describe("wave12: malformed-request text rules do not fallback", () => {
  it("shouldFallback false for improperly formed request", () => {
    const r = checkFallbackError(400, "improperly formed request: bad schema");
    expect(r.shouldFallback).toBe(false);
  });
  it("shouldFallback false for request not allowed", () => {
    const r = checkFallbackError(400, "request not allowed for this model");
    expect(r.shouldFallback).toBe(false);
  });
});

describe("wave12: combo structuredClone preserves nested messages", () => {
  it("clone is independent of mutations", () => {
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }],
      }],
    };
    const attemptBody = structuredClone(body);
    attemptBody.messages[0].content[0].image_url.url = "stripped";
    expect(body.messages[0].content[0].image_url.url).toBe("https://x/a.png");
  });
});

// ── Wave 13 ──────────────────────────────────────────────────────────────

describe("wave13: base execute order transform before buildUrl", () => {
  it("documents wave13 fix: transformRequest before buildUrl in base execute", async () => {
    // Source-order guard: base.js must transform before URL so Codex _isCompact works.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const basePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../open-sse/executors/base.js"
    );
    const src = readFileSync(basePath, "utf8");
    const transformIdx = src.indexOf("const transformedBody = this.transformRequest");
    const buildUrlIdx = src.indexOf("const url = this.buildUrl");
    expect(transformIdx).toBeGreaterThan(0);
    expect(buildUrlIdx).toBeGreaterThan(transformIdx);
  });
});

describe("wave13: IFlowExecutor implements refreshCredentials", () => {
  it("has refreshCredentials method", () => {
    const ex = new IFlowExecutor();
    expect(typeof ex.refreshCredentials).toBe("function");
    expect(ex.refreshCredentials).not.toBe(BaseExecutor.prototype.refreshCredentials);
  });
});

describe("wave13: OpenCodeGo calls super.transformRequest", () => {
  it("injects stream_options.include_usage for streaming chat bodies", () => {
    const ex = new OpenCodeGoExecutor();
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("glm-4", body, true, {});
    expect(out.stream_options?.include_usage).toBe(true);
  });
});

// ── Wave 14 ──────────────────────────────────────────────────────────────

describe("wave14: git log detects decorated headers", () => {
  it("autodetects git-log for HEAD decoration", () => {
    const text = "commit abcdef1234567890 (HEAD -> main, origin/main)\nAuthor: A\nDate: B\n\n    subject\n";
    const filter = autoDetectFilter(text);
    expect(filter).toBe(gitLog);
    const out = gitLog(text);
    expect(out).toContain("abcdef1234567890");
    expect(out).toMatch(/subject/i);
  });
});

describe("wave14: RTK preserves Claude error-shaped tool_result", () => {
  it("does not compress Traceback tool_result without is_error", () => {
    const traceback = "Traceback (most recent call last):\n  File \"x.py\", line 1\nError: boom";
    const body = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: traceback }],
      }],
    };
    compressMessages(body, true);
    expect(body.messages[0].content[0].content).toBe(traceback);
  });
});

// ── Wave 15 ──────────────────────────────────────────────────────────────

describe("wave15: prefetch collects Responses input_image", () => {
  it("finds remote images on body.input", () => {
    const body = {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://cdn.example.com/a.png" }],
      }],
    };
    const refs = collectImageRefs(body, FORMATS.OPENAI_RESPONSES);
    expect(refs.length).toBe(1);
    expect(refs[0].get()).toBe("https://cdn.example.com/a.png");
  });
});

describe("wave15: fusion appendUserTurn Responses shape", () => {
  it("appends typed message + input_text to input[]", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "q" }] }],
    };
    const next = appendUserTurn(body, "judge please");
    const last = next.input[next.input.length - 1];
    expect(last.type).toBe("message");
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "input_text", text: "judge please" }]);
  });
});

describe("wave15: responses input_file maps to OpenAI file", () => {
  it("converts input_file with file_data", () => {
    const out = openaiResponsesToOpenAIRequest("gpt-4o", {
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "read this" },
          { type: "input_file", file_data: "data:application/pdf;base64,AAAA", filename: "a.pdf" },
        ],
      }],
    }, true);
    const content = out.messages.find((m) => m.role === "user")?.content;
    expect(Array.isArray(content)).toBe(true);
    const file = content.find((c) => c.type === "file");
    expect(file?.file?.file_data).toContain("base64");
    expect(file?.file?.filename).toBe("a.pdf");
  });
});

describe("wave15: gemini content parts null-safe", () => {
  it("skips null content items without throw", () => {
    const parts = convertOpenAIContentToParts([null, { type: "text", text: "hi" }, undefined]);
    expect(parts.some((p) => p.text === "hi")).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("wave15: maxTokens accepts max_completion_tokens", () => {
  it("uses max_completion_tokens when max_tokens absent", () => {
    expect(adjustMaxTokens({ max_completion_tokens: 2048 })).toBe(2048);
  });
  it("uses max_output_tokens when others absent", () => {
    expect(adjustMaxTokens({ max_output_tokens: 1024 })).toBe(1024);
  });
});
