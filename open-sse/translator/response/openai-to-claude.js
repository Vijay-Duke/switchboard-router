import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, OPENAI_BLOCK, MODEL_FALLBACK } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Detect and deduplicate doubled JSON (e.g. {"query":"x"}{"query":"x"}).
// Some OpenAI-compatible models emit tool arguments as the same object twice.
// Switchboard PR#2279.
function deduplicateDoubledJson(str) {
  if (!str || str.length < 4) return str;
  // Exact doubling is the only viable shape: one split point, no scan. Large
  // malformed payloads (the common case) bail out fast instead of O(n^2).
  if (str.length > 65536) return str;
  if (str.length % 2 !== 0) return str;
  const half = str.length / 2;
  if (str.slice(0, half) === str.slice(half)) return str.slice(0, half);
  return str;
}

// Sanitize an incoming tool_call id to the Anthropic charset
// (^[a-zA-Z0-9_-]+$); falls back to null when nothing survives.
// Mirrors sanitizeToolId in concerns/toolCall.js (kept local: that helper is
// request-side private).
function sanitizeToolCallId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    const deduplicated = deduplicateDoubledJson(argsJson);
    if (deduplicated !== argsJson) {
      try {
        const args = JSON.parse(deduplicated);
        const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
          ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
          : toolName;
        if (name === "Read") sanitizeReadArgs(args);
        return JSON.stringify(args);
      } catch { /* fall through */ }
    }
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  const results = [];

  // Flush: stream ended without finish_reason. Synthesize terminal events
  // so the client doesn't hang waiting for message_stop.
  if (chunk === null && !state.claudeFinishHandled) {
    state.claudeFinishHandled = true;
    // A stream that died before message_start is an upstream failure, not an
    // empty answer: emit nothing (never a bare message_delta/message_stop,
    // never a synthetic empty turn) so the client SDK surfaces the incomplete
    // stream and can retry. Same posture as kiro-to-claude and the
    // antigravity EOF gate.
    if (!state.messageStartSent) return null;
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    // Materialize args-only indices whose identity never arrived (nameless
    // fallback — mirrors the finish arm below).
    if (state.toolArgBuffers) {
      for (const idx of state.toolArgBuffers.keys()) {
        if (!state.toolCalls?.has(idx)) {
          const toolBlockIndex = state.nextBlockIndex++;
          if (!state.toolCalls) state.toolCalls = new Map();
          state.toolCalls.set(idx, { id: `toolu_${Date.now()}_${idx}`, name: "", blockIndex: toolBlockIndex });
          results.push({
            type: "content_block_start",
            index: toolBlockIndex,
            content_block: { type: CLAUDE_BLOCK.TOOL_USE, id: state.toolCalls.get(idx).id, name: "", input: {} }
          });
        }
      }
    }

    for (const [idx, toolInfo] of state.toolCalls || []) {
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized }
        });
      }
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }

    state.finishReason = "stop";
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
    return results.length > 0 ? results : null;
  }

  // Track usage from OpenAI chunk if available (before the choices early
  // return so choiceless trailing usage chunks still record state.usage).
  if (chunk?.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens.
    // Clamp: misbehaving upstreams can report cache details larger than prompt.
    const inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheCreateTokens);

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  if (!chunk || !chunk.choices?.[0]) return null;

  const choice = chunk.choices[0];
  const delta = choice.delta;

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace(/^chatcmpl-/, "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Open a text block on demand and append a text delta.
  const emitText = (text) => {
    if (!text) return;
    stopThinkingBlock(state, results);
    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text }
    });
  };

  // Forward one OpenAI image_url entry as a Claude image block (data URIs as
  // base64, remote URIs as url source) or a markdown note when unparseable.
  const emitImageEntry = (entry) => {
    const url = entry?.image_url?.url;
    if (typeof url !== "string" || !url) return;
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);
    const imageBlockIndex = state.nextBlockIndex++;
    const dataUri = url.match(/^data:([^;]+);base64,([\s\S]+)$/);
    const source = dataUri
      ? { type: "base64", media_type: dataUri[1], data: dataUri[2] }
      : { type: "url", url };
    results.push({
      type: "content_block_start",
      index: imageBlockIndex,
      content_block: { type: CLAUDE_BLOCK.IMAGE, source }
    });
    results.push({ type: "content_block_stop", index: imageBlockIndex });
  };

  // Handle regular content (string or content-block array with image_url parts)
  if (typeof delta?.content === "string" && delta.content) {
    emitText(delta.content);
  } else if (Array.isArray(delta?.content)) {
    for (const part of delta.content) {
      if (typeof part === "string") emitText(part);
      else if (part?.type === "text" && part.text) emitText(part.text);
      else if (part?.type === OPENAI_BLOCK.IMAGE_URL && part.image_url) emitImageEntry(part);
    }
  }

  // Legacy gemini image shape (delta.images) — same forwarding as above.
  if (Array.isArray(delta?.images)) {
    for (const entry of delta.images) emitImageEntry(entry);
  }

  // Voice transcripts and policy refusals share the text-block path verbatim.
  emitText(delta?.audio?.transcript);
  emitText(typeof delta?.refusal === "string" ? delta.refusal : "");

  // Open one tool_use block for an index (identity must be known: id or name).
  const openToolBlock = (idx, tc) => {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    const toolBlockIndex = state.nextBlockIndex++;
    const toolId = sanitizeToolCallId(tc.id) || `toolu_${Date.now()}_${idx}`;
    state.toolCalls.set(idx, { id: toolId, name: tc.function?.name || "", blockIndex: toolBlockIndex });

    // Strip prefix from tool name for response
    let toolName = tc.function?.name || "";
    if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
      toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
    }

    results.push({
      type: "content_block_start",
      index: toolBlockIndex,
      content_block: {
        type: CLAUDE_BLOCK.TOOL_USE,
        id: toolId,
        name: toolName,
        input: {}
      }
    });
  };

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // Defer opening until identity (id or name) is known: args-first chunks
      // buffer below and the block opens with the real name when it arrives.
      if (!state.toolCalls.has(idx) && (tc.id || tc.function?.name)) {
        openToolBlock(idx, tc);
      } else if (state.toolCalls.has(idx)) {
        const existing = state.toolCalls.get(idx);
        if (existing) {
          // Late-arriving real id after synthetic open: prefer real id in state.
          // (content_block_start already sent with synthetic — clients pair on that.)
          const cleanId = sanitizeToolCallId(tc.id);
          if (cleanId && String(existing.id).startsWith("toolu_")) {
            existing.id = cleanId;
          }
          // Late-arriving name after id-only open: repair stored name (used for
          // arg sanitization at finish).
          if (!existing.name && tc.function?.name) {
            existing.name = tc.function.name;
          }
        }
      }

      if (tc.function?.arguments) {
        // Buffer args independent of block existence — sanitize at finish.
        if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
        state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + tc.function.arguments);
      }
    }
  }

  // Finish — guard against duplicate finish_reason chunks (common with
  // OpenAI-compatible models; without this tool args are emitted twice →
  // doubled JSON). Switchboard PR#2279.
  if (choice.finish_reason && !state.claudeFinishHandled) {
    state.claudeFinishHandled = true;
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    // Materialize args-only indices whose identity never arrived (nameless
    // fallback — same terminal shape as before the deferred-open change).
    if (state.toolArgBuffers) {
      for (const idx of state.toolArgBuffers.keys()) {
        if (!state.toolCalls.has(idx)) openToolBlock(idx, {});
      }
    }

    for (const [idx, toolInfo] of state.toolCalls || []) {
      // Emit buffered + sanitized args as single delta before stop
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized }
        });
      }
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
