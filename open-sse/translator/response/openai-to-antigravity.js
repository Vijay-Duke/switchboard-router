import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { GEMINI_ROLE, OPENAI_FINISH, GEMINI_FINISH, OPENAI_BLOCK } from "../schema/index.js";
import { extractReasoningText } from "../concerns/reasoning.js";
import { parseDataUri } from "../concerns/image.js";

const FINISH_REASON_MAP = {
  [OPENAI_FINISH.STOP]: GEMINI_FINISH.STOP,
  [OPENAI_FINISH.LENGTH]: GEMINI_FINISH.MAX_TOKENS,
  [OPENAI_FINISH.TOOL_CALLS]: GEMINI_FINISH.STOP,
  [OPENAI_FINISH.CONTENT_FILTER]: GEMINI_FINISH.SAFETY,
  // Aborted upstream turns (e.g. Gemini MALFORMED_FUNCTION_CALL via the hub)
  // must not surface as clean STOPs.
  [OPENAI_FINISH.ERROR]: GEMINI_FINISH.MALFORMED_FUNCTION_CALL,
};

function appendToolCallParts(state, parts) {
  for (const idx of Object.keys(state._toolCallAccum)) {
    const accum = state._toolCallAccum[idx];
    let args = {};
    try { args = JSON.parse(accum.arguments); } catch {
      // Truncated mid-args payloads fail closed to {} — mark the corruption
      // in-turn instead of emitting silent empty args.
      if (accum.arguments) parts.push({ text: "[tool arguments truncated in transit]" });
    }
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

// Map an OpenAI image_url value to a Gemini part: data URIs become inlineData,
// remote URLs become fileData references.
function toImagePart(url) {
  const parsed = parseDataUri(url);
  if (parsed) return { inlineData: { mime_type: parsed.mimeType, data: parsed.base64 } };
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    return { fileData: { fileUri: url } };
  }
  return null;
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
    // A stream that died before any content flowed is a stall, not an empty
    // answer — let the stream layer's stall/empty guards handle it.
    if (!state._sawContent) {
      const toolKeys = Object.keys(state._toolCallAccum || {});
      if (toolKeys.length === 0) return null;
    }
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
    // Split-usage upstreams send finish first, then a choiceless usage chunk.
    // Once finished, deliver the stored usage in a parts-light response.
    if (state._finishHandled) {
      return buildResponse(state, [], null, chunk.usage || state._usage);
    }
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;
  if (finishReason && state._finishHandled) return null;
  if (!state._responseId) state._responseId = chunk.id || `resp_${Date.now()}`;
  if (!state._modelVersion) state._modelVersion = chunk.model || "";

  const parts = [];
  const markFlow = () => { state._sawContent = true; };

  // Thinking/reasoning across vendor shapes → thought part
  const thinking = extractReasoningText(delta);
  if (thinking) {
    parts.push({ thought: true, text: thinking });
    markFlow();
  }

  // Text content. Claude thinking round-trips through OpenAI as literal
  // <think> markers (content-only OpenAI clients rely on them); Gemini-family
  // clients get thought parts instead.
  const pushThoughtText = (text) => {
    const re = /<think>([\s\S]*?)<\/think>/g;
    let last = 0;
    let m;
    let emitted = false;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        parts.push({ text: text.slice(last, m.index) });
        emitted = true;
      }
      if (m[1]) {
        parts.push({ thought: true, text: m[1] });
        emitted = true;
      }
      last = m.index + m[0].length;
    }
    const tail = text.slice(last);
    // Exact lone markers carry no text — drop them silently.
    if (tail && tail !== "<think>" && tail !== "</think>") {
      parts.push({ text: tail });
      emitted = true;
    }
    return emitted;
  };
  if (typeof delta.content === "string" && delta.content) {
    if (delta.content === "<think>" || delta.content === "</think>") {
      // Lone marker chunk — absorbed, not forwarded.
    } else if (pushThoughtText(delta.content)) {
      markFlow();
    }
  } else if (Array.isArray(delta.content)) {
    for (const part of delta.content) {
      if (typeof part === "string") {
        if (part !== "<think>" && part !== "</think>" && part) {
          parts.push({ text: part });
          markFlow();
        }
      } else if (part?.type === "text" && part.text) {
        parts.push({ text: part.text });
        markFlow();
      } else if (part?.type === OPENAI_BLOCK.IMAGE_URL && part.image_url?.url) {
        const imagePart = toImagePart(part.image_url.url);
        if (imagePart) {
          parts.push(imagePart);
          markFlow();
        }
      }
    }
  }

  // Legacy gemini image shape (delta.images) — same inlineData forwarding.
  if (Array.isArray(delta.images)) {
    for (const entry of delta.images) {
      const imagePart = entry?.image_url?.url ? toImagePart(entry.image_url.url) : null;
      if (imagePart) {
        parts.push(imagePart);
        markFlow();
      }
    }
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
        // Fragment-then-full retransmit (look + lookup): adopt the longer full
        // name instead of discarding it as a duplicate.
        else if (n.startsWith(accum.name) && n.length > accum.name.length) accum.name = n;
        else if (!accum.name.endsWith(n) && !n.startsWith(accum.name)) accum.name += n;
      }
      if (tc.function?.arguments) {
        accum.arguments += tc.function.arguments;
        markFlow();
      }
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
