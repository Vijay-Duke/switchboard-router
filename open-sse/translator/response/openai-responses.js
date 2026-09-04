/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
// Claim a distinct Responses output_index per item key (text/tools/reasoning
// must never share one). Stored on state so later delta/done events reuse it.
function claimOutputIndex(state, key) {
  if (typeof state.nextOutputIndex !== "number") state.nextOutputIndex = 0;
  if (!state.outputIndexByKey || typeof state.outputIndexByKey !== "object") state.outputIndexByKey = {};
  if (state.outputIndexByKey[key] === undefined) {
    state.outputIndexByKey[key] = state.nextOutputIndex++;
  }
  return state.outputIndexByKey[key];
}

// Normalize an OpenAI usage payload into buildUsage args (cache + reasoning).
function openAIUsageArgs(usage) {
  return {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    cacheCreationTokens: usage.prompt_tokens_details?.cache_creation_tokens || 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
  };
}

// OpenAI usage → Responses response.usage shape.
function toResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) out.input_tokens_details = { cached_tokens: cached };
  return out;
}

export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }

  // Harvest usage even on choiceless chunks (split-usage upstreams).
  if (chunk.usage && typeof chunk.usage === "object") {
    state.usage = buildUsage(openAIUsageArgs(chunk.usage));
  }

  if (!chunk.choices?.length) return [];

  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details)
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    // A chunk can carry trailing thinking text AND a tool call — fall through
    // to the tool/finish blocks below instead of returning early.
    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
    } else if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls (empty array is truthy; require a real call)
  if (delta.tool_calls && delta.tool_calls.length) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    // Truncated turns surface as incomplete (unless a tool call is pending —
    // that still finalizes as a completed tool turn).
    const pendingTool = Object.keys(state.funcCallIds || {}).length > 0;
    if (!pendingTool && (choice.finish_reason === OPENAI_FINISH.LENGTH ||
        choice.finish_reason === OPENAI_FINISH.CONTENT_FILTER)) {
      sendIncomplete(state, emit, choice.finish_reason);
    } else {
      sendCompleted(state, emit);
    }
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = claimOutputIndex(state, "reasoning");

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: RESPONSES_ITEM.REASONING, summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: {
        id: state.reasoningId,
        type: RESPONSES_ITEM.REASONING,
        summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }]
      }
    });
  }
}

function emitTextContent(state, emit, idx, content) {
  const outIdx = claimOutputIndex(state, `msg:${idx}`);
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${idx}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outIdx,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;

    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: outIdx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: outIdx,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;
    const outIdx = claimOutputIndex(state, `msg:${idx}`);

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outIdx,
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: outIdx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outIdx,
      item: {
        id: msgId,
        type: RESPONSES_ITEM.MESSAGE,
        content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }],
        role: ROLE.ASSISTANT
      }
    });
  }
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  if (funcName) state.funcNames[tcIdx] = funcName;

  if (!state.funcCallIds[tcIdx] && newCallId) {
    state.funcCallIds[tcIdx] = newCallId;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: claimOutputIndex(state, `tool:${tcIdx}`),
      item: {
        id: `fc_${newCallId}`,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: "",
        call_id: newCallId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  } else if (!state.funcCallIds[tcIdx] && !newCallId &&
      (tc.function?.name || tc.function?.arguments)) {
    // Name-first / id-less upstreams: synthesize a stable id so the call is
    // not silently dropped (late real ids overwrite below via funcNames path).
    state.funcCallIds[tcIdx] = fallbackToolCallId(tcIdx);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: claimOutputIndex(state, `tool:${tcIdx}`),
      item: {
        id: `fc_${state.funcCallIds[tcIdx]}`,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: "",
        call_id: state.funcCallIds[tcIdx],
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (refCallId) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: claimOutputIndex(state, `tool:${tcIdx}`),
        delta: tc.function.arguments
      });
    }
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";
    const outIdx = claimOutputIndex(state, `tool:${idx}`);

    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      output_index: outIdx,
      arguments: args
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outIdx,
      item: {
        id: `fc_${callId}`,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: args,
        call_id: callId,
        name: state.funcNames[idx] || ""
      }
    });

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

function terminalPayload(state, status, extra = {}) {
  const response = {
    id: state.responseId,
    object: "response",
    created_at: state.created,
    status,
    background: false,
    error: null,
    ...extra
  };
  const usage = toResponsesUsage(state.usage);
  if (usage) response.usage = usage;
  return response;
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.completed", {
      type: "response.completed",
      response: terminalPayload(state, "completed")
    });
  }
}

function sendIncomplete(state, emit, finishReason) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.incomplete", {
      type: "response.incomplete",
      response: terminalPayload(state, "incomplete", {
        incomplete_details: {
          reason: finishReason === OPENAI_FINISH.CONTENT_FILTER ? "content_filter" : "max_output_tokens"
        }
      })
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

// response.incomplete carries incomplete_details.reason ("max_output_tokens" |
// "content_filter"). Map it to a Chat Completions finish_reason; a pending
// tool call still finalizes as tool_calls.
function incompleteFinishReason(state, data) {
  if (state.toolCallIndex > 0 || state.currentToolCallId) return OPENAI_FINISH.TOOL_CALLS;
  return data?.response?.incomplete_details?.reason === "content_filter"
    ? OPENAI_FINISH.CONTENT_FILTER
    : OPENAI_FINISH.LENGTH;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
// First emitted delta chunk carries the assistant role (once per stream).
function firstChatRole(state) {
  if (state.roleSent) return {};
  state.roleSent = true;
  return { role: ROLE.ASSISTANT };
}

// Stable per-call OpenAI tool index for parallel Responses tool calls:
// assigned at output_item.added time, reused by delta/done via call_id.
function respToolIndex(state, callId) {
  if (typeof state.toolCallIndex !== "number") state.toolCallIndex = 0;
  if (!state.respCallIndex || typeof state.respCallIndex !== "object") state.respCallIndex = {};
  if (state.respCallIndex[callId] === undefined) {
    state.respCallIndex[callId] = state.toolCallIndex++;
  }
  return state.respCallIndex[callId];
}

// Resolve an arguments-delta item_id to its call_id: the pairing recorded at
// output_item.added, else the Switchboard-emitted `fc_<call_id>` shape when
// that call_id is already known. Never allocates an index from an item_id.
function respCallIdFromItemId(state, itemId) {
  if (typeof itemId !== "string" || !itemId) return null;
  const paired = state.respItemCall?.[itemId];
  if (paired) return paired;
  if (itemId.startsWith("fc_")) {
    const candidate = itemId.slice(3);
    if (state.respCallIndex?.[candidate] !== undefined) return candidate;
  }
  return null;
}

export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason. An unstarted stream still
    // terminates with a stop chunk so every stream ends with a finish_reason.
    if (state.finishReasonSent) return null;
    if (!state.started) {
      state.started = true;
      state.chatId = `chatcmpl-${Date.now()}`;
      state.created = Math.floor(Date.now() / 1000);
      state.toolCallIndex = 0;
      state.currentToolCallId = null;
    }

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    state.hadContent = true;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { ...firstChatRole(state), content: delta }
    );
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Refusal deltas surface as content; a refusal-only turn finishes as
  // content_filter at response.completed time (see below).
  if (eventType === "response.refusal.delta" || eventType === "response.refusal.done") {
    const refusalText = data.delta || data.text || data.refusal || "";
    if (refusalText) {
      // Refusal text flows to the client but does not count as real content:
      // a refusal-only turn still finishes as content_filter below.
      state.refused = true;
      return buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        { ...firstChatRole(state), content: refusalText }
      );
    }
    if (eventType === "response.refusal.done") state.refused = true;
    return null;
  }

  // Function call started (standard function_call or custom_tool_call)
  if (eventType === "response.output_item.added" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || fallbackToolCallId();
    state.hadContent = true;
    const callIdx = respToolIndex(state, state.currentToolCallId);
    // Real Responses streams route argument deltas by item.id (fc_...), which
    // is NOT derived from call_id — remember the pairing for the delta path.
    if (typeof item.id === "string" && item.id) {
      if (!state.respItemCall || typeof state.respItemCall !== "object") state.respItemCall = {};
      state.respItemCall[item.id] = state.currentToolCallId;
    }

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      {
        ...firstChatRole(state),
        tool_calls: [{
          index: callIdx,
          id: state.currentToolCallId,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: item.name || "", arguments: "" }
        }]
      }
    );
  }

  // Function call arguments delta (standard or custom_tool_call variant)
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || data.deltaText || "";
    if (!argsDelta) return null;
    const deltaCallId = respCallIdFromItemId(state, data.item_id) || state.currentToolCallId;
    const deltaIdx = deltaCallId ? respToolIndex(state, deltaCallId) : state.toolCallIndex;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [{ index: deltaIdx, function: { arguments: argsDelta } }] }
    );
  }

  // Function call done (standard or custom_tool_call variant). Indices were
  // assigned at added time — nothing to advance here.
  if (eventType === "response.output_item.done" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    return null;
  }

  // Response completed (or incomplete: truncated turn, e.g. max_output_tokens)
  if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      const cacheCreationTokens = responseUsage.input_tokens_details?.cache_creation_tokens || responseUsage.cache_creation_input_tokens || 0;
      const reasoningTokens = responseUsage.output_tokens_details?.reasoning_tokens || 0;

      state.usage = buildUsage({ promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: cacheReadTokens, cacheCreationTokens, reasoningTokens });
    }

    if (!state.finishReasonSent) {
      let finishReason = eventType === "response.incomplete"
        ? incompleteFinishReason(state, data)
        : computeFinishReason(state);
      // A refusal-terminated turn with no other content is a policy refusal,
      // not a clean stop.
      if (state.refused && !state.hadContent) finishReason = OPENAI_FINISH.CONTENT_FILTER;

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js
      
      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }
      
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return buildChunk(
        { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
        { content: `[Error] ${error.message || JSON.stringify(error)}` },
        OPENAI_FINISH.STOP
      );
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { ...firstChatRole(state), ...reasoningDelta(delta) }
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
