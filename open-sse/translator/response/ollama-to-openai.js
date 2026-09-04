import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

/**
 * Convert Ollama NDJSON response to OpenAI SSE format
 *
 * Ollama response format:
 * {"model": "...", "message": {"role": "assistant", "content": "..."}, "done": false}
 * {"model": "...", "done": true, "prompt_eval_count": 123, "eval_count": 456}
 *
 * OpenAI format:
 * {"id": "...", "object": "chat.completion.chunk", "created": 123, "model": "...",
 *  "choices": [{"index": 0, "delta": {"content": "..."}, "finish_reason": null}]}
 */
export function ollamaToOpenAIResponse(chunk, state) {
  // EOF flush: a truncated stream (no done:true line) still terminates exactly
  // once; a fresh stream stays silent.
  if (!chunk) {
    if (state.ollamaFinished || !state.ollamaSawContent) return null;
    state.ollamaFinished = true;
    const { id, created, model } = state.ollama || {};
    const flushChunk = buildChunk(
      { id: id || `chatcmpl-${Date.now()}`, created: created || Math.floor(Date.now() / 1000), model: model || "ollama" },
      {},
      state.hadToolCalls ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP
    );
    if (state.ollamaUsage) flushChunk.usage = state.ollamaUsage;
    return flushChunk;
  }

  // Tolerate raw NDJSON lines (string chunks) — parse, drop only on failure.
  if (typeof chunk === "string") {
    const line = chunk.trim();
    if (!line || line === "[DONE]") return null;
    try {
      chunk = JSON.parse(line.startsWith("data:") ? line.slice(5).trim() : line);
    } catch {
      return null;
    }
  }
  if (!chunk || typeof chunk !== "object") return null;

  // Initialize state on first chunk
  if (!state.ollama) {
    state.ollama = {
      id: `chatcmpl-${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      model: chunk.model || state.model
    };
    state.toolCallIndex = 0;
    state.ollamaStreamTs = Date.now();
  }
  if (typeof state.toolCallIndex !== "number") state.toolCallIndex = 0;

  const { id, created, model } = state.ollama;

  // Final chunk with done=true
  if (chunk.done) {
    const usage = extractUsage(chunk);
    state.ollamaUsage = usage;
    state.ollamaFinished = true;

    // Determine finish_reason: map upstream done_reason, override to tool_calls if tools used
    let finishReason = toOpenAIFinish(chunk.done_reason, "ollama");
    if (chunk.done_reason === OPENAI_FINISH.TOOL_CALLS || state.hadToolCalls) {
      finishReason = OPENAI_FINISH.TOOL_CALLS;
    }

    const doneChunk = buildChunk({ id, created, model }, {}, finishReason);
    doneChunk.usage = usage;
    return doneChunk;
  }

  // Content chunk
  const message = chunk.message;
  if (!message) return null;

  const content = typeof message.content === "string" ? message.content : "";
  const thinking = typeof message.thinking === "string" ? message.thinking : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;

  // Skip empty chunks
  if (!content && !thinking && !toolCalls) return null;

  // Accumulate content in state
  if (content) {
    state.accumulatedContent = (state.accumulatedContent || "") + content;
  }
  if (thinking) {
    state.accumulatedThinking = (state.accumulatedThinking || "") + thinking;
  }

  const delta = {};
  if (content) {
    delta.content = content;
    state.ollamaSawContent = true;
  }
  if (thinking) {
    delta.reasoning_content = thinking;
    state.ollamaSawContent = true;
  }

  // Convert Ollama tool_calls to OpenAI format. Real Ollama emits one tool per
  // chunk with no id/index — allocate stream-wide indices/ids so multi-tool
  // turns never collide on index 0 with duplicate ids.
  if (toolCalls) {
    state.hadToolCalls = true;
    state.ollamaSawContent = true;
    const base = state.toolCallIndex;
    delta.tool_calls = convertToolCalls(toolCalls, base, state.ollamaStreamTs);
    state.toolCallIndex = base + toolCalls.length;
  }

  return buildChunk({ id, created, model }, delta, null);
}

/**
 * Extract usage stats from Ollama response
 */
function extractUsage(ollamaChunk) {
  return toOpenAIUsage(ollamaChunk, "ollama");
}

/**
 * Convert tool_calls from Ollama format to OpenAI format.
 * base is the stream-wide starting index. Synthesized ids embed that index
 * (unique within the turn) plus a per-stream timestamp (unique across turns —
 * clients key tool_use/tool_result pairing on ids across the whole transcript).
 */
function convertToolCalls(toolCalls, base = 0, streamTs = Date.now()) {
  return toolCalls.map((tc, i) => ({
    index: tc.function?.index ?? (base + i),
    id: tc.id || `call_${base + i}_${streamTs}`,
    type: OPENAI_BLOCK.FUNCTION,
    function: {
      name: tc.function?.name || "",
      arguments: typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments || {})
    }
  }));
}

/**
 * Convert Ollama non-streaming response body to OpenAI chat.completion format
 */
export function ollamaBodyToOpenAI(body) {
  const msg = body.message || {};
  const content = msg.content || "";
  const thinking = msg.thinking || "";
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const message = { role: ROLE.ASSISTANT };
  if (content) message.content = content;
  if (thinking) message.reasoning_content = thinking;
  if (toolCalls.length > 0) message.tool_calls = convertToolCalls(toolCalls);
  if (!message.content && !message.tool_calls) message.content = "";

  let finishReason = toOpenAIFinish(body.done_reason, "ollama");
  if (toolCalls.length > 0) finishReason = OPENAI_FINISH.TOOL_CALLS;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "ollama",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: extractUsage(body)
  };
}

// Register translator
register(FORMATS.OLLAMA, FORMATS.OPENAI, null, ollamaToOpenAIResponse);
