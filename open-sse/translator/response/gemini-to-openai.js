import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH, DEFAULT_IMAGE_MIME } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { encodeDataUri } from "../concerns/image.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

// Build chunk meta for current gemini state
function chunkMeta(state) {
  return { id: `chatcmpl-${state.messageId}`, created: Math.floor(Date.now() / 1000), model: state.model };
}

// Build a tool_call chunk from a gemini functionCall part (shared by sig/non-sig branches)
function emitFunctionCall(functionCall, state) {
  const rawName = functionCall.name;
  // Restore original tool name from mapping (AG cloaking)
  const fcName = state.toolNameMap?.get(rawName) || rawName;
  const fcArgs = functionCall.args || {};
  const toolCallIndex = state.functionIndex++;
  // Sanitize the name fragment: Gemini allows characters (dots/spaces) that
  // downstream id charsets (Anthropic ^[a-zA-Z0-9_-]+$) reject. Decimal clock
  // with dash separators keeps the golden-snapshot volatile strip
  // (-<10+digits>-<digits>) matching verbatim so snapshots stay deterministic.
  const safeName = String(fcName).replace(/[^a-zA-Z0-9_-]/g, "");
  const toolCall = {
    id: `call_${safeName}-${Date.now()}-${toolCallIndex}`,
    index: toolCallIndex,
    type: OPENAI_BLOCK.FUNCTION,
    function: { name: fcName, arguments: JSON.stringify(fcArgs) },
  };
  // Keep Gemini bookkeeping separate from the shared translator state.toolCalls map.
  // The downstream OpenAI→Claude translator uses state.toolCalls for Claude block
  // metadata; pre-populating it here makes Anthropic tool deltas lose index.
  state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;
  return buildChunk(chunkMeta(state), { tool_calls: [toolCall] }, null);
}

// Emit one image as an OpenRouter-style `delta.images` entry. delta.content
// stays a string: OpenAI clients concatenate it verbatim, so an array there
// renders as "[object Object]" or fails their chunk schema. Pivot consumers
// (openai-to-claude / openai-to-antigravity) read delta.images.
function emitImageDelta(url, state) {
  return buildChunk(
    chunkMeta(state),
    { images: [{ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url } }] },
    null
  );
}

// Convert Gemini response chunk to OpenAI format
export function geminiToOpenAIResponse(chunk, state) {
  // EOF flush: a truncated stream (no finishReason) still terminates exactly
  // once; virgin or already-finished streams stay silent.
  if (!chunk) {
    if (state.finishReason || !state.messageId) return null;
    let finishReason = OPENAI_FINISH.STOP;
    if ((state.geminiToolCallCount || 0) > 0) finishReason = OPENAI_FINISH.TOOL_CALLS;
    state.finishReason = finishReason;
    const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
    if (state.usage) finalChunk.usage = state.usage;
    return [finalChunk];
  }

  // Handle Antigravity wrapper
  const response = chunk.response || chunk;
  if (!response || !response.candidates?.[0]) {
    // Prompt-level safety block (no candidates): surface as a content_filter
    // terminal with usage instead of an empty hang.
    if (response?.promptFeedback?.blockReason) {
      const fresh = !state.messageId;
      if (fresh) {
        state.messageId = response.responseId || `msg_${Date.now()}`;
        state.model = response.modelVersion || "gemini";
        state.functionIndex = 0;
        state.geminiToolCallCount = 0;
      }
      state.usage = toOpenAIUsage(response.usageMetadata || chunk.usageMetadata, "gemini") || state.usage;
      const finishReason = toOpenAIFinish(response.promptFeedback.blockReason, "gemini");
      const out = [];
      if (fresh) out.push(buildChunk(chunkMeta(state), { role: ROLE.ASSISTANT }, null));
      const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
      if (state.usage) finalChunk.usage = state.usage;
      out.push(finalChunk);
      return out;
    }
    return null;
  }

  const results = [];
  const candidate = response.candidates[0];
  const content = candidate.content;

  // Initialize state
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || "gemini";
    state.functionIndex = 0;
    state.geminiToolCallCount = 0;
    results.push(buildChunk(chunkMeta(state), { role: ROLE.ASSISTANT }, null));
  }

  // Process parts
  if (content?.parts) {
    for (const part of content.parts) {
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      const isThought = part.thought === true;

      // Media parts ride on any part (including signature-carrying ones), so
      // extract them before the thought-signature branch below continues.
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || DEFAULT_IMAGE_MIME;
        results.push(emitImageDelta(encodeDataUri(mimeType, inlineData.data), state));
      }

      // GCS/URI-referenced media: surface as an image_url entry (image mimes)
      // so the reference is never silently dropped.
      const fileUri = part.fileData?.fileUri || part.fileData?.file_uri;
      if (fileUri && !inlineData?.data) {
        const fileMime = part.fileData?.mimeType || part.fileData?.mime_type || "";
        if (typeof fileUri === "string" && (fileMime.startsWith("image/") || fileMime === "")) {
          results.push(emitImageDelta(fileUri, state));
        } else if (typeof fileUri === "string") {
          results.push(buildChunk(chunkMeta(state), { content: `[File: ${fileUri}]` }, null));
        }
      }

      // Handle thought signature (thinking mode)
      if (hasThoughtSig) {
        const hasTextContent = part.text !== undefined && part.text !== "";
        const hasFunctionCall = !!part.functionCall;

        if (hasTextContent) {
          results.push(buildChunk(
            chunkMeta(state),
            isThought ? reasoningDelta(part.text) : { content: part.text },
            null
          ));
        }

        if (hasFunctionCall) {
          results.push(emitFunctionCall(part.functionCall, state));
        }
        continue;
      }

      // Text content. Gemini marks model-internal thinking with `thought: true`.
      // Some responses include a thoughtSignature, but Google AI Studio/Gemini API
      // can also stream thought parts without a signature; those must not be
      // surfaced as normal assistant content in OpenAI-compatible clients.
      if (part.text !== undefined && part.text !== "") {
        results.push(buildChunk(
          chunkMeta(state),
          isThought ? reasoningDelta(part.text) : { content: part.text },
          null
        ));
      }

      // Function call
      if (part.functionCall) {
        results.push(emitFunctionCall(part.functionCall, state));
      }
    }
  }

  // Usage metadata - extract before finish reason so we can include it
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  const geminiUsage = toOpenAIUsage(usageMeta, "gemini");
  if (geminiUsage) state.usage = geminiUsage;

  // Finish reason - include usage in final chunk
  if (candidate.finishReason) {
    let finishReason = toOpenAIFinish(candidate.finishReason, "gemini");
    if (finishReason === OPENAI_FINISH.STOP && state.geminiToolCallCount > 0) {
      finishReason = OPENAI_FINISH.TOOL_CALLS;
    }
    
    const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
    
    // Include usage in final chunk for downstream translators
    if (state.usage) {
      finalChunk.usage = state.usage;
    }
    
    results.push(finalChunk);
    state.finishReason = finishReason;
  }

  return results.length > 0 ? results : null;
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.VERTEX, FORMATS.OPENAI, null, geminiToOpenAIResponse);
