/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

const DEFAULT_STREAM_TO_JSON_MAX_BYTES = 16 * 1024 * 1024;

function streamToJsonMaxBytes(maxBytes) {
  if (Number.isFinite(maxBytes) && maxBytes > 0) return maxBytes;
  const raw = globalThis.process?.env?.STREAM_TO_JSON_MAX_BYTES;
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_TO_JSON_MAX_BYTES;
}

class StreamToJsonMaxBytesError extends Error {
  constructor(maxBytes) {
    super(`SSE stream exceeded STREAM_TO_JSON_MAX_BYTES (${maxBytes} bytes)`);
    this.name = "StreamToJsonMaxBytesError";
  }
}

function countChunkBytes(value) {
  if (!value) return 0;
  if (typeof value.byteLength === "number") return value.byteLength;
  if (typeof value.length === "number") return value.length;
  return 0;
}

function assertWithinMaxBytes(bytesRead, maxBytes) {
  if (bytesRead > maxBytes) throw new StreamToJsonMaxBytesError(maxBytes);
}

function createChatCompletionState(fallbackModel) {
  return {
    fallbackModel,
    seenChunk: false,
    first: null,
    contentParts: [],
    reasoningParts: [],
    toolCallMap: new Map(),
    finishReason: "stop",
    usage: null
  };
}

function processChatCompletionChunk(chunk, state) {
  if (!state.seenChunk) {
    state.first = chunk || {};
    state.seenChunk = true;
  }

  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};
  if (typeof delta.content === "string" && delta.content.length > 0) state.contentParts.push(delta.content);
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) state.reasoningParts.push(delta.reasoning_content);
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  if (chunk?.usage && typeof chunk.usage === "object") state.usage = chunk.usage;

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state.toolCallMap.has(idx)) {
        state.toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
      }
      const existing = state.toolCallMap.get(idx);
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.function.name += tc.function.name;
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
    }
  }
}

function processChatCompletionSSELine(line, state) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  try { processChatCompletionChunk(JSON.parse(payload), state); } catch { /* ignore malformed lines */ }
}

function buildChatCompletionResponse(state) {
  if (!state.seenChunk) return null;

  const first = state.first || {};
  const message = {
    role: "assistant",
    content: state.contentParts.join("") || (state.toolCallMap.size > 0 ? null : "")
  };
  if (state.reasoningParts.length > 0) message.reasoning_content = state.reasoningParts.join("");
  if (state.toolCallMap.size > 0) {
    message.tool_calls = [...state.toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || state.fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: state.finishReason }]
  };
  if (state.usage) result.usage = state.usage;
  return result;
}

export function parseChatCompletionsSSEToJson(rawSSE, fallbackModel, { maxBytes } = {}) {
  const text = String(rawSSE || "");
  const limit = streamToJsonMaxBytes(maxBytes);
  assertWithinMaxBytes(new TextEncoder().encode(text).byteLength, limit);

  const state = createChatCompletionState(fallbackModel);
  for (const line of text.split("\n")) {
    processChatCompletionSSELine(line, state);
  }
  return buildChatCompletionResponse(state);
}

export async function convertChatCompletionsStreamToJson(stream, fallbackModel, { maxBytes } = {}) {
  if (!stream || typeof stream.getReader !== "function") return null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const limit = streamToJsonMaxBytes(maxBytes);
  const state = createChatCompletionState(fallbackModel);
  let buffer = "";
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += countChunkBytes(value);
      assertWithinMaxBytes(bytesRead, limit);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processChatCompletionSSELine(line, state);
      }
    }

    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer) processChatCompletionSSELine(buffer, state);
  } catch (err) {
    try { await reader.cancel(err); } catch { /* ignore cancel errors */ }
    throw err;
  } finally {
    reader.releaseLock();
  }

  return buildChatCompletionResponse(state);
}

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, { maxBytes } = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maxBodyBytes = streamToJsonMaxBytes(maxBytes);
  let buffer = "";
  let totalBytes = 0;

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += countChunkBytes(value);
      assertWithinMaxBytes(totalBytes, maxBodyBytes);

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } catch (err) {
    try { await reader.cancel(err); } catch { /* ignore cancel errors */ }
    throw err;
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
