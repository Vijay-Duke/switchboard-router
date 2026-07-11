import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { GEMINI_ROLE, OPENAI_FINISH, GEMINI_FINISH } from "../schema/index.js";

const FINISH_REASON_MAP = {
  [OPENAI_FINISH.STOP]: GEMINI_FINISH.STOP,
  [OPENAI_FINISH.LENGTH]: GEMINI_FINISH.MAX_TOKENS,
  [OPENAI_FINISH.TOOL_CALLS]: GEMINI_FINISH.STOP,
  [OPENAI_FINISH.CONTENT_FILTER]: GEMINI_FINISH.SAFETY,
};

function appendToolCallParts(state, parts) {
  for (const idx of Object.keys(state._toolCallAccum)) {
    const accum = state._toolCallAccum[idx];
    let args = {};
    try { args = JSON.parse(accum.arguments); } catch { /* empty */ }
    const originalName = state.toolNameMap?.get(accum.name) || accum.name;
    parts.push({
      functionCall: {
        name: originalName,
        args,
      },
    });
  }
}

function buildResponse(state, parts, finishReason = null, usage = state._usage) {
  const candidate = { content: { role: GEMINI_ROLE.MODEL, parts } };
  if (finishReason) {
    candidate.finishReason = FINISH_REASON_MAP[finishReason] || GEMINI_FINISH.STOP;
  }

  const response = {
    candidates: [candidate],
    modelVersion: state._modelVersion,
    responseId: state._responseId,
  };

  if (usage) {
    response.usageMetadata = {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0,
    };
    if (usage.completion_tokens_details?.reasoning_tokens) {
      response.usageMetadata.thoughtsTokenCount = usage.completion_tokens_details.reasoning_tokens;
    }
    if (usage.prompt_tokens_details?.cached_tokens) {
      response.usageMetadata.cachedContentTokenCount = usage.prompt_tokens_details.cached_tokens;
    }
  }

  return { response };
}

// Convert OpenAI SSE chunk to Antigravity SSE format
// Real Antigravity format:
//   data: {"response":{"candidates":[{"content":{"role":"model","parts":[...]}, "finishReason":"STOP"}], "usageMetadata":{...}, "modelVersion":"...", "responseId":"..."}}
// Tool calls: OpenAI sends incremental args across chunks → accumulate and emit ONCE at finish
export function openaiToAntigravityResponse(chunk, state) {
  if (!state._toolCallAccum) state._toolCallAccum = {};

  // Gemini-family clients do not use OpenAI's [DONE] sentinel; the final
  // candidate with finishReason STOP is their terminal response. Emit it on
  // EOF so buffered tool calls do not disappear when upstream truncates.
  if (chunk === null) {
    if (state._finishHandled) return null;
    if (!state._responseId) state._responseId = `resp_${Date.now()}`;
    if (!state._modelVersion) state._modelVersion = "";
    state._finishHandled = true;
    const parts = [];
    appendToolCallParts(state, parts);
    if (parts.length === 0) parts.push({ text: "" });
    return buildResponse(state, parts, OPENAI_FINISH.STOP);
  }

  if (!chunk) return null;

  if (chunk.usage && typeof chunk.usage === "object") {
    state._usage = chunk.usage;
  }

  const choice = chunk.choices?.[0];
  if (!choice) {
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;
  if (finishReason && state._finishHandled) return null;
  if (!state._responseId) state._responseId = chunk.id || `resp_${Date.now()}`;
  if (!state._modelVersion) state._modelVersion = chunk.model || "";

  const parts = [];

  // Thinking/reasoning → thought part
  if (delta.reasoning_content) {
    parts.push({ thought: true, text: delta.reasoning_content });
  }

  // Text content
  if (delta.content) {
    parts.push({ text: delta.content });
  }

  // Accumulate tool calls silently (no emit until finish)
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state._toolCallAccum[idx]) {
        state._toolCallAccum[idx] = { id: "", name: "", arguments: "" };
      }
      const accum = state._toolCallAccum[idx];
      if (tc.id) accum.id = tc.id;
      // Name arrives once (or as fragments without full re-send). Prefer set-if-empty
      // then only append when the delta is a non-duplicate fragment (wave9 — name +=
      // was doubling "lookup" → "lookuplookup" and breaking toolNameMap).
      if (tc.function?.name) {
        const n = tc.function.name;
        if (!accum.name) accum.name = n;
        else if (!accum.name.endsWith(n) && !n.startsWith(accum.name)) accum.name += n;
      }
      if (tc.function?.arguments) accum.arguments += tc.function.arguments;
    }
    // Skip emit — wait for finish_reason
    if (parts.length === 0 && !finishReason) return null;
  }

  // On finish, emit accumulated tool calls as complete functionCall parts
  if (finishReason) {
    appendToolCallParts(state, parts);
    state._finishHandled = true;
  }

  // Skip empty non-finish chunks
  if (parts.length === 0 && !finishReason) return null;

  // Ensure at least empty text part on finish with no content
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" });
  }

  return buildResponse(state, parts, finishReason, chunk.usage || state._usage);
}

// Register
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, null, openaiToAntigravityResponse);
