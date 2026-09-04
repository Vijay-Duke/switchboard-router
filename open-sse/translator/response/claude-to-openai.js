import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

// Create OpenAI chunk helper (created is pinned per stream in message_start).
function createChunk(state, delta, finishReason = null) {
  return buildChunk(
    { id: `chatcmpl-${state.messageId}`, created: state.created ?? Math.floor(Date.now() / 1000), model: state.model },
    delta,
    finishReason
  );
}

// Build OpenAI usage from merged Claude token state (message_start cache +
// message_delta output). Shared by the message_delta and message_stop arms so
// stop-only streams keep cache attribution.
function claudeStateToUsage(state) {
  return toOpenAIUsage({
    input_tokens: state.usage.input_tokens || 0,
    output_tokens: state.usage.output_tokens || 0,
    cache_read_input_tokens: state.usage.cache_read_input_tokens,
    cache_creation_input_tokens: state.usage.cache_creation_input_tokens
  }, "claude");
}

// Convert Claude stream chunk to OpenAI format
export function claudeToOpenAIResponse(chunk, state) {
  // EOF flush: a truncated stream (no message_stop) still terminates exactly
  // once with any accumulated usage; virgin streams stay silent.
  if (!chunk) {
    if (state.finishReasonSent || !state.messageId) return null;
    state.finishReasonSent = true;
    const finishReason = state.finishReason ||
      (state.toolCalls?.size > 0 ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP);
    const finalChunk = createChunk(state, {}, finishReason);
    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = claudeStateToUsage(state);
    }
    return [finalChunk];
  }

  const results = [];
  const event = chunk.type;

  switch (event) {
    case "error": {
      // Mid-stream Anthropic error (overload/auth): terminate visibly instead
      // of yielding a hollow truncated success.
      results.push(createChunk(state, { content: `[Error] ${chunk.error?.message || "upstream error"}` }, OPENAI_FINISH.STOP));
      state.finishReason = OPENAI_FINISH.STOP;
      state.finishReasonSent = true;
      break;
    }

    case "message_start": {
      state.messageId = chunk.message?.id || `msg_${Date.now()}`;
      state.model = chunk.message?.model || state.model || MODEL_FALLBACK;
      if (state.created == null) state.created = Math.floor(Date.now() / 1000);
      state.toolCallIndex = 0;
      // Claude sends input_tokens + cache_read + cache_creation here; message_delta
      // later carries only the final output_tokens. Capture cache now so the
      // delta (output-only) doesn't reset it to zero.
      const startUsage = chunk.message?.usage;
      if (startUsage && typeof startUsage === "object") {
        const inputTokens = typeof startUsage.input_tokens === "number" ? startUsage.input_tokens : 0;
        const cacheReadTokens = typeof startUsage.cache_read_input_tokens === "number" ? startUsage.cache_read_input_tokens : 0;
        const cacheCreationTokens = typeof startUsage.cache_creation_input_tokens === "number" ? startUsage.cache_creation_input_tokens : 0;
        const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: promptTokens,
          input_tokens: inputTokens,
          output_tokens: 0
        };
        if (cacheReadTokens > 0) state.usage.cache_read_input_tokens = cacheReadTokens;
        if (cacheCreationTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationTokens;
      }
      results.push(createChunk(state, { role: ROLE.ASSISTANT }));
      break;
    }

    case "content_block_start": {
      const block = chunk.content_block;
      if (block?.type === "server_tool_use") {
        // Built-in tool (web search) - Claude handles internally, skip
        state.serverToolBlockIndex = chunk.index;
        break;
      }
      if (block?.type === CLAUDE_BLOCK.THINKING) {
        state.inThinkingBlock = true;
        state.currentBlockIndex = chunk.index;
        results.push(createChunk(state, { content: "<think>" }));
      } else if (block?.type === CLAUDE_BLOCK.REDACTED_THINKING) {
        // Opaque ciphertext: a visible reasoning placeholder, never the data.
        // Not a <think> span — nothing streams for it, so no marker pair.
        results.push(createChunk(state, reasoningDelta("[redacted]")));
      } else if (block?.type === "web_search_tool_result") {
        // Claude server-side web-search results: surface the citations
        // (title + url only — encrypted_content is opaque and must not leak
        // into the visible answer) so the client sees what the answer cites.
        const items = Array.isArray(block.content) ? block.content : [];
        const citations = items
          .filter((item) => typeof item?.url === "string" && item.url)
          .map((item) => `- [${item.title || item.url}](${item.url})`);
        results.push(createChunk(state, {
          content: citations.length > 0 ? `\n${citations.join("\n")}\n` : "[web search results omitted]"
        }));
      } else if (block?.type === CLAUDE_BLOCK.TOOL_USE) {
        const toolCallIndex = state.toolCallIndex++;
        // Restore original tool name from mapping (Claude OAuth cloaking).
        const toolName = state.toolNameMap?.get(block.name) || block.name;
        const toolCall = {
          index: toolCallIndex,
          id: block.id,
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: toolName,
            arguments: ""
          }
        };
        state.toolCalls.set(chunk.index, toolCall);
        results.push(createChunk(state, { tool_calls: [toolCall] }));
      }
      break;
    }

    case "content_block_delta": {
      // Skip deltas for built-in server tool blocks (web search). The -1
      // guard keeps indexless deltas flowing on fresh state (sentinel init).
      if (state.serverToolBlockIndex !== -1 && chunk.index === state.serverToolBlockIndex) break;
      const delta = chunk.delta;
      if (delta?.type === "text_delta" && delta.text) {
        results.push(createChunk(state, { content: delta.text }));
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        results.push(createChunk(state, reasoningDelta(delta.thinking)));
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const toolCall = state.toolCalls.get(chunk.index);
        if (toolCall) {
          toolCall.function.arguments += delta.partial_json;
          results.push(createChunk(state, {
            tool_calls: [{
              index: toolCall.index,
              id: toolCall.id,
              function: { arguments: delta.partial_json }
            }]
          }));
        }
      }
      break;
    }

    case "content_block_stop": {
      // Skip stop for built-in server tool blocks (web search)
      if (state.serverToolBlockIndex !== -1 && chunk.index === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      if (state.inThinkingBlock && chunk.index === state.currentBlockIndex) {
        results.push(createChunk(state, { content: "</think>" }));
        state.inThinkingBlock = false;
      }
      break;
    }

    case "message_delta": {
      // Extract usage from message_delta event (Claude native format).
      // Anthropic sends input/cache in message_start and only output here, so
      // fall back to cache captured in message_start when the delta omits it.
      if (chunk.usage && typeof chunk.usage === "object") {
        const prev = state.usage || {};
        const inputTokens = typeof chunk.usage.input_tokens === "number" ? chunk.usage.input_tokens : (prev.input_tokens || 0);
        const outputTokens = typeof chunk.usage.output_tokens === "number" ? chunk.usage.output_tokens : 0;
        const cacheReadTokens = typeof chunk.usage.cache_read_input_tokens === "number" ? chunk.usage.cache_read_input_tokens : (prev.cache_read_input_tokens || 0);
        const cacheCreationTokens = typeof chunk.usage.cache_creation_input_tokens === "number" ? chunk.usage.cache_creation_input_tokens : (prev.cache_creation_input_tokens || 0);

        // prompt_tokens = input_tokens + cache_read + cache_creation (all prompt-side tokens)
        const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

        state.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
          input_tokens: inputTokens,
          output_tokens: outputTokens
        };

        if (cacheReadTokens > 0) state.usage.cache_read_input_tokens = cacheReadTokens;
        if (cacheCreationTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationTokens;
      }

      if (chunk.delta?.stop_reason) {
        state.finishReason = convertStopReason(chunk.delta.stop_reason);
        const finalChunk = createChunk(state, {}, state.finishReason);

        if (state.usage) {
          // Build OpenAI usage from the merged state (cache from message_start +
          // output from message_delta), not the delta chunk alone.
          finalChunk.usage = claudeStateToUsage(state);
        }

        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason = state.finishReason || (state.toolCalls?.size > 0 ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP);
        // Same cache-inclusive fold as message_delta (stop-only streams).
        const usageObj = (state.usage && typeof state.usage === 'object') ? {
          usage: claudeStateToUsage(state)
        } : {};
        results.push({ ...createChunk(state, {}, finishReason), ...usageObj });
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length > 0 ? results : null;
}

const convertStopReason = (reason) => toOpenAIFinish(reason, "claude");

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, null, claudeToOpenAIResponse);
