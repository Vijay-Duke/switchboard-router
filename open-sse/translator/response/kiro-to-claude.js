/**
 * Kiro → Claude Response Translator (DIRECT route, no OpenAI pivot)
 *
 * IMPORTANT: This translator does NOT receive raw Kiro AWS-EventStream frames.
 * KiroExecutor.transformEventStreamToSSE() (open-sse/executors/kiro.js) already
 * parses the binary EventStream and emits OpenAI-shaped
 * `chat.completion.chunk` objects. So the chunks arriving here are OpenAI
 * streaming chunks, and our job is OpenAI-chunk → Claude SSE events — the same
 * transformation openai-to-claude.js performs. We re-implement it here so the
 * direct `kiro:claude` route is self-contained and lossless (reasoning_content
 * → thinking blocks, tool_calls → tool_use blocks, usage → message_delta).
 *
 * Registered on the direct route by ../index.js; reached only when source
 * format is Claude and target is Kiro.
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { extractReasoningText } from "../concerns/reasoning.js";

function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({ type: "content_block_stop", index: state.thinkingBlockIndex });
  state.thinkingBlockStarted = false;
}

function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({ type: "content_block_stop", index: state.textBlockIndex });
  state.textBlockStarted = false;
}

function convertFinishReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/**
 * Convert one OpenAI-format chunk (from KiroExecutor) into Claude SSE events.
 * Returns an array of Claude events, or null when the chunk yields nothing.
 */
export function kiroToClaudeResponse(chunk, state) {
  const results = [];

  // Flush: Kiro can close without a finish_reason. Synthesize the same
  // terminal Claude events as openai-to-claude so buffered tool calls and
  // message_stop are not lost at EOF.
  if (chunk === null && !state.claudeFinishHandled) {
    state.claudeFinishHandled = true;
    // A stream that died before message_start is an upstream failure, not an
    // empty answer: emit nothing so the client SDK surfaces the incomplete
    // stream (Claude Code retries) instead of a silent empty end_turn. The
    // executor-level empty-stream guards have already had their retries.
    if (!state.messageStartSent) return null;
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [idx, toolInfo] of state.toolCalls || []) {
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        results.push({
          type: "content_block_delta",
          index: toolInfo.blockIndex,
          delta: { type: "input_json_delta", partial_json: buffered },
        });
      }
      results.push({ type: "content_block_stop", index: toolInfo.blockIndex });
    }

    state.finishReason = "stop";
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: finalUsage,
    });
    results.push({ type: "message_stop" });
    return results;
  }

  if (chunk === null) return null;

  // KiroExecutor emits chat.completion.chunk objects; tolerate string chunks
  // by attempting a parse (defensive — the direct path is always objects).
  let data = chunk;
  if (typeof chunk === "string") {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === "[DONE]") return null;
    try {
      data = JSON.parse(trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed);
    } catch {
      return null;
    }
  }

  if (!data || !data.choices?.[0]) return null;

  const choice = data.choices[0];
  const delta = choice.delta || {};

  // Track usage if present on the chunk (fold cache details like
  // openai-to-claude: input_tokens excludes cache, details re-attached).
  if (data.usage && typeof data.usage === "object") {
    const promptTokens =
      typeof data.usage.prompt_tokens === "number" ? data.usage.prompt_tokens : 0;
    const outputTokens =
      typeof data.usage.completion_tokens === "number"
        ? data.usage.completion_tokens
        : 0;
    const cacheDetails = data.usage.prompt_tokens_details || {};
    const cacheReadTokens =
      typeof cacheDetails.cached_tokens === "number" ? cacheDetails.cached_tokens : 0;
    const cacheCreateTokens =
      typeof cacheDetails.cache_creation_tokens === "number" ? cacheDetails.cache_creation_tokens : 0;
    state.usage = {
      input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheCreateTokens),
      output_tokens: outputTokens,
    };
    if (cacheReadTokens > 0) state.usage.cache_read_input_tokens = cacheReadTokens;
    if (cacheCreateTokens > 0) state.usage.cache_creation_input_tokens = cacheCreateTokens;
  }

  // First chunk → emit message_start.
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId =
      (typeof data.id === "string" && data.id.replace(/^chatcmpl-/, "")) ||
      `msg_${Date.now()}`;
    state.model = data.model || "kiro";
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Reasoning / thinking content across vendor shapes (reasoning_content /
  // reasoning / reasoning_details[] — Kiro reasoningContentEvent feeds
  // reasoning_content; MiniMax-shaped deltas feed reasoning_details[]).
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);
    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent },
    });
  }

  // Regular text content.
  if (delta.content) {
    stopThinkingBlock(state, results);
    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }
    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Tool calls.
  if (delta.tool_calls) {
    if (!state.toolCalls) state.toolCalls = new Map();
    if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      // Open tool block once per index (re-open on every id delta broke Claude clients — wave11).
      if (!state.toolCalls.has(idx) && (tc.id || tc.function?.name || tc.function?.arguments)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);
        const toolBlockIndex = state.nextBlockIndex++;
        const toolId = tc.id || `toolu_${Date.now()}_${idx}`;
        state.toolCalls.set(idx, {
          id: toolId,
          name: tc.function?.name || "",
          blockIndex: toolBlockIndex,
        });
        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: tc.function?.name || "",
            input: {},
          },
        });
      } else if (tc.id && state.toolCalls.has(idx)) {
        const existing = state.toolCalls.get(idx);
        if (existing && String(existing.id).startsWith("toolu_")) existing.id = tc.id;
      }
      if (tc.function?.arguments !== undefined && tc.function?.arguments !== "") {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          // Object-form arguments must stringify — raw concatenation yields
          // "[object Object]".
          const frag = typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : (tc.function.arguments == null ? "" : JSON.stringify(tc.function.arguments));
          state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + frag);
        }
      }
    }
  }

  // Finish.
  if (choice.finish_reason && !state.claudeFinishHandled) {
    state.claudeFinishHandled = true;
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    if (state.toolCalls) {
      for (const [idx, toolInfo] of state.toolCalls) {
        const buffered = state.toolArgBuffers?.get(idx);
        if (buffered) {
          results.push({
            type: "content_block_delta",
            index: toolInfo.blockIndex,
            delta: { type: "input_json_delta", partial_json: buffered },
          });
        }
        results.push({ type: "content_block_stop", index: toolInfo.blockIndex });
      }
    }

    state.finishReason = choice.finish_reason;
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage,
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

/**
 * Non-streaming Kiro → Claude. KiroExecutor only produces a stream, so this is
 * a defensive helper for any non-streaming caller that hands us an aggregated
 * OpenAI-shaped completion.
 */
export function kiroToClaudeNonStreaming(data) {
  const content = [];
  const choice = data?.choices?.[0];
  const message = choice?.message || {};

  const nonStreamReasoning = message.reasoning_content || message.reasoning || "";
  if (nonStreamReasoning) {
    content.push({ type: "thinking", thinking: nonStreamReasoning });
  }
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input =
          typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function?.name || "",
        input,
      });
    }
  }

  const usage = data?.usage || {};
  const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const cacheDetails = usage.prompt_tokens_details || {};
  const cacheReadTokens =
    typeof cacheDetails.cached_tokens === "number" ? cacheDetails.cached_tokens : 0;
  const cacheCreateTokens =
    typeof cacheDetails.cache_creation_tokens === "number" ? cacheDetails.cache_creation_tokens : 0;
  const claudeUsage = {
    input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheCreateTokens),
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  };
  if (cacheReadTokens > 0) claudeUsage.cache_read_input_tokens = cacheReadTokens;
  if (cacheCreateTokens > 0) claudeUsage.cache_creation_input_tokens = cacheCreateTokens;
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: data?.model || "kiro",
    stop_reason: convertFinishReason(choice?.finish_reason || "stop"),
    usage: claudeUsage,
  };
}

register(FORMATS.KIRO, FORMATS.CLAUDE, null, kiroToClaudeResponse);
