import { FORMATS } from "../translator/formats.js";
import { fallbackToolCallId } from "../translator/concerns/toolCall.js";

// Parse SSE data line (or NDJSON). L1: also accept raw JSON lines for non-Ollama
// providers that emit NDJSON, and multi-line payloads joined with \n.
export function parseSSELine(line, format = null) {
  if (!line) return null;

  const trimmed = line.trim();

  // NDJSON / raw JSON line (Ollama + other NDJSON upstreams)
  if (format === FORMATS.OLLAMA || (trimmed.startsWith("{") && !trimmed.startsWith("data:"))) {
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return null;
      }
    }
    if (format === FORMATS.OLLAMA) return null;
  }

  // Standard SSE format: "data: {...}" (also "data:line1\\ndata:line2" after join)
  if (trimmed.startsWith("data:")) {
    // Support multi-line SSE: each data: segment joined with \n
    const payload = trimmed
      .split("\n")
      .map((l) => {
        const t = l.trim();
        if (t.startsWith("data:")) return t.slice(5).replace(/^ /, "");
        return t;
      })
      .join("\n")
      .trim();
    if (payload === "[DONE]") return { done: true };
    try {
      return JSON.parse(payload);
    } catch (error) {
      if (payload.length > 0 && payload.length < 1000) {
        console.log(`[WARN] Failed to parse SSE line (${payload.length} chars): ${payload.substring(0, 100)}...`);
      }
      return null;
    }
  }

  return null;
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    // Content can be a string or a content-block array (image_url parts).
    const hasContent = typeof delta.content === "string"
      ? delta.content !== ""
      : Array.isArray(delta.content) && delta.content.length > 0;
    return hasContent ||
           delta.reasoning_content && delta.reasoning_content !== "" ||
           delta.reasoning && delta.reasoning !== "" ||
           delta.tool_calls && delta.tool_calls.length > 0 ||
           delta.images && delta.images.length > 0 ||
           chunk.choices[0].finish_reason ||
           delta.role;
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";
    
    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

// Ensure every streamed tool_call carries an id (#4992).
// OpenAI's contract puts the id on the FIRST fragment of a call; some providers
// open a new `index` in a later fragment without one, and strict clients
// (@ai-sdk/openai-compatible: "Expected 'id' to be a string") abort the turn.
// Remember the id per index and mint a stable one when an index is new.
// Returns true when the chunk was modified.
export function ensureStreamToolCallIds(chunk, seenIds) {
  if (!chunk?.choices?.length) return false;
  let changed = false;
  for (const choice of chunk.choices) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      if (typeof tc.id === "string" && tc.id.length > 0) {
        if (tc.index !== undefined) seenIds.set(tc.index, tc.id);
        continue;
      }
      // Reuse the id already seen for this index (stable for the whole call),
      // or mint one when the index is new to the client.
      const known = tc.index !== undefined ? seenIds.get(tc.index) : undefined;
      const id = known || fallbackToolCallId(tc.index, tc.function?.name);
      tc.id = id;
      if (tc.index !== undefined) seenIds.set(tc.index, id);
      changed = true;
    }
  }
  return changed;
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId = parsed.extend_fields?.requestId || 
                      parsed.extend_fields?.traceId || 
                      Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  let cleaned = payload;

  if ("usage" in cleaned) {
    if (cleaned.usage === null) {
      const { usage, ...payloadWithoutUsage } = cleaned;
      cleaned = payloadWithoutUsage;
    } else if (typeof cleaned.usage === "object" && cleaned.usage.perf_metrics === null) {
      const { perf_metrics, ...usageWithoutPerf } = cleaned.usage;
      cleaned = { ...cleaned, usage: usageWithoutPerf };
    }
  }

  if (cleaned.response && typeof cleaned.response === "object" && !Array.isArray(cleaned.response)) {
    const cleanedResponse = cleanUsagePayload(cleaned.response);
    if (cleanedResponse !== cleaned.response) {
      cleaned = { ...cleaned, response: cleanedResponse };
    }
  }

  return cleaned;
}

// Format output as SSE
export function formatSSE(data, sourceFormat) {
  if (data === null || data === undefined) return "data: null\n\n";
  if (data && data.done) return "data: [DONE]\n\n";

  // OpenAI Responses API format
  if (data && data.event && data.data) {
    const cleanedEventData = cleanUsagePayload(data.data);
    return `event: ${data.event}\ndata: ${JSON.stringify(cleanedEventData)}\n\n`;
  }

  data = cleanUsagePayload(data);

  // Claude format
  if (sourceFormat === FORMATS.CLAUDE && data && data.type) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return `data: ${JSON.stringify(data)}\n\n`;
}
