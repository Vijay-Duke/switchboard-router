/**
 * Cursor to OpenAI Response Translator
 * CursorExecutor already emits OpenAI format - this is a passthrough
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { OPENAI_FINISH } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";

/**
 * Convert Cursor response to OpenAI format
 * Since CursorExecutor.transformProtobufToSSE/JSON already emits OpenAI chunks,
 * this is a passthrough translator (similar to Kiro pattern)
 */
export function cursorToOpenAIResponse(chunk, state) {
  // EOF flush: a truncated stream (no finish chunk) still terminates exactly
  // once; a fresh stream stays silent.
  if (!chunk) {
    if (state.cursorFinished) return null;
    if (!state.cursorSawContent) return null;
    state.cursorFinished = true;
    return buildChunk(
      {
        id: state.cursorId || `chatcmpl-${Date.now()}`,
        created: state.cursorCreated || Math.floor(Date.now() / 1000),
        model: state.cursorModel || "cursor"
      },
      {},
      state.hadToolCalls ? OPENAI_FINISH.TOOL_CALLS : OPENAI_FINISH.STOP
    );
  }

  // If chunk is already in OpenAI format (from executor transform), return as-is
  if (chunk.object === "chat.completion.chunk" && chunk.choices) {
    state.cursorSawContent = true;
    if (!state.cursorId) {
      state.cursorId = chunk.id;
      state.cursorCreated = chunk.created;
      state.cursorModel = chunk.model;
    }
    if (chunk.choices[0]?.finish_reason) {
      state.cursorFinished = true;
    } else if (chunk.choices[0]?.delta?.tool_calls?.length) {
      state.hadToolCalls = true;
    }
    return chunk;
  }

  // If chunk is a completion object (non-streaming), return as-is
  if (chunk.object === "chat.completion" && chunk.choices) {
    return chunk;
  }

  // Unknown shapes (protobuf edges, error frames) are dropped — forwarding
  // them verbatim breaks OpenAI JSON decoders downstream.
  return null;
}

register(FORMATS.CURSOR, FORMATS.OPENAI, null, cursorToOpenAIResponse);
