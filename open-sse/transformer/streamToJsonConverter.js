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
    harvestResponsesUsage(state, parsed);
  } else if (eventType === "response.incomplete") {
    state.status = "incomplete";
    harvestResponsesUsage(state, parsed);
  } else if (eventType === "response.failed") {
    state.status = "failed";
  } else if (eventType === "response.output_text.delta") {
    const idx = parsed.output_index ?? 0;
    if (typeof parsed.delta === "string" && parsed.delta.length > 0) {
      state.deltaText.set(idx, (state.deltaText.get(idx) || "") + parsed.delta);
    }
  } else if (eventType === "response.function_call_arguments.delta") {
    const idx = parsed.output_index ?? 0;
    if (typeof parsed.delta === "string" && parsed.delta.length > 0) {
      state.deltaArgs.set(idx, (state.deltaArgs.get(idx) || "") + parsed.delta);
    }
  }
}

function harvestResponsesUsage(state, parsed) {
  if (parsed.response?.usage) {
    state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
    state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
    state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

const DEFAULT_STREAM_TO_JSON_MAX_BYTES = 16 * 1024 * 1024;

export function streamToJsonMaxBytes(maxBytes) {
  if (Number.isFinite(maxBytes) && maxBytes > 0) return maxBytes;
  const raw = globalThis.process?.env?.STREAM_TO_JSON_MAX_BYTES;
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_TO_JSON_MAX_BYTES;
}

export class StreamToJsonMaxBytesError extends Error {
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

export function assertWithinMaxBytes(bytesRead, maxBytes) {
  if (bytesRead > maxBytes) throw new StreamToJsonMaxBytesError(maxBytes);
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

// Read one chunk, racing client abort. Cancels the upstream reader on abort
// so a disconnected client stops consuming egress.
function abortableStreamRead(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      // Reject BEFORE cancelling: cancel settles the pending read with
      // done:true synchronously, and Promise.race would then resolve on it.
      reject(abortError());
      try { reader.cancel(abortError()).catch(() => {}); } catch { /* already closed */ }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([reader.read(), aborted]).finally(() => {
    signal.removeEventListener?.("abort", onAbort);
  });
}

function createChoiceAccumulator() {
  return {
    contentParts: [],
    reasoningParts: [],
    toolCallMap: new Map(),
    finishReason: "stop"
  };
}

function createChatCompletionState(fallbackModel) {
  return {
    fallbackModel,
    seenChunk: false,
    first: null,
    choiceMap: new Map(),
    usage: null
  };
}

function choiceState(state, index) {
  let acc = state.choiceMap.get(index);
  if (!acc) {
    acc = createChoiceAccumulator();
    state.choiceMap.set(index, acc);
  }
  return acc;
}

function processChatCompletionChunk(chunk, state) {
  if (!state.seenChunk) {
    state.first = chunk || {};
    state.seenChunk = true;
  }

  if (chunk?.usage && typeof chunk.usage === "object") state.usage = chunk.usage;
  if (!Array.isArray(chunk?.choices)) return;

  for (const choice of chunk.choices) {
    const acc = choiceState(state, choice?.index ?? 0);
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) acc.contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) acc.reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason;

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!acc.toolCallMap.has(idx)) {
          acc.toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = acc.toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) {
          // Append fragments (OpenAI splits names across chunks) but ignore an
          // exact repeat of the full name, which some providers re-send per
          // chunk and would otherwise corrupt to `getget_weather`.
          if (!existing.function.name) existing.function.name = tc.function.name;
          else if (existing.function.name !== tc.function.name) existing.function.name += tc.function.name;
        }
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
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
  if (state.choiceMap.size === 0) state.choiceMap.set(0, createChoiceAccumulator());
  const choices = [...state.choiceMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => {
      const message = {
        role: "assistant",
        content: acc.contentParts.join("") || (acc.toolCallMap.size > 0 ? null : "")
      };
      if (acc.reasoningParts.length > 0) message.reasoning_content = acc.reasoningParts.join("");
      if (acc.toolCallMap.size > 0) {
        message.tool_calls = [...acc.toolCallMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => ({
            ...tc,
            function: { name: tc.function.name, arguments: tc.function.arguments || "{}" }
          }));
      }
      return { index, message, finish_reason: acc.finishReason };
    });

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || state.fallbackModel || "unknown",
    choices
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

export async function convertChatCompletionsStreamToJson(stream, fallbackModel, { maxBytes, signal } = {}) {
  if (!stream || typeof stream.getReader !== "function") return null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const limit = streamToJsonMaxBytes(maxBytes);
  const state = createChatCompletionState(fallbackModel);
  let buffer = "";
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await abortableStreamRead(reader, signal);
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
export async function convertResponsesStreamToJson(stream, { maxBytes, signal } = {}) {
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
    items: new Map(),
    deltaText: new Map(),
    deltaArgs: new Map()
  };

  try {
    while (true) {
      const { done, value } = await abortableStreamRead(reader, signal);
      if (done) break;

      totalBytes += countChunkBytes(value);
      assertWithinMaxBytes(totalBytes, maxBodyBytes);

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
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

  // Build output array from accumulated items (ordered by index).
  // Delta-only streams never emit output_item.done — synthesize items from
  // accumulated deltas instead of emitting gap-filler placeholders.
  for (const [idx, text] of state.deltaText) {
    if (!state.items.has(idx) && text) {
      state.items.set(idx, {
        id: `msg_${state.responseId || "synth"}_${idx}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }]
      });
    }
  }
  for (const [idx, args] of state.deltaArgs) {
    if (!state.items.has(idx) && args) {
      state.items.set(idx, {
        id: `fc_synth_${idx}`,
        type: "function_call",
        call_id: "",
        name: "",
        arguments: args
      });
    }
  }
  const output = [...state.items.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
}
