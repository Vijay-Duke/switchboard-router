/**
 * Kiro to OpenAI Response Translator
 * Converts Kiro/AWS CodeWhisperer streaming events to OpenAI SSE format
 */
import { register } from "../registry.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";

// Build chunk meta for current kiro state
function chunkMeta(state) {
  return { id: state.responseId, created: state.created, model: state.model || "kiro" };
}

/**
 * Parse Kiro SSE event and convert to OpenAI format
 * Kiro events: assistantResponseEvent, codeEvent, supplementaryWebLinksEvent, etc.
 */
export function kiroToOpenAIResponse(chunk, state) {
  // Flush: a deferred stop-only finish (waiting on usage) terminates here;
  // a mid-content truncation synthesizes a finish so the stream terminates.
  if (!chunk) {
    if (!state.finishEmitted) {
      const finishReason = state.pendingFinish ||
        ((state.chunkIndex || 0) > 0 || state.hadToolUse
          ? toOpenAIFinish(state.hadToolUse ? "tool_use" : "stop", "kiro")
          : null);
      if (finishReason) {
        state.finishEmitted = true;
        const pending = buildChunk(chunkMeta(state), {}, finishReason);
        if (state.usage && typeof state.usage === "object") pending.usage = state.usage;
        state.pendingFinish = null;
        return pending;
      }
    }
    return null;
  }

  // If chunk is already in OpenAI format (from executor transform), return as-is
  if (chunk.object === "chat.completion.chunk" && chunk.choices) {
    return chunk;
  }
  
  // Handle string chunk (raw SSE data)
  let data = chunk;
  if (typeof chunk === "string") {
    // Parse SSE format: event:xxx\ndata:xxx
    const lines = chunk.split("\n");
    let eventType = "";
    let eventData = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith(":event-type:")) {
        eventType = line.slice(12).trim();
      } else if (line.startsWith("data:")) {
        eventData = line.slice(5).trim();
      } else if (line.startsWith(":content-type:")) {
        // Skip content-type header
      } else if (line.trim() && !line.startsWith(":")) {
        // Raw JSON data
        eventData = line.trim();
      }
    }

    if (!eventData) return null;

    try {
      data = JSON.parse(eventData);
      data._eventType = eventType;
    } catch {
      // Not JSON, might be raw text
      data = { text: eventData, _eventType: eventType };
    }
  }

  // Initialize state if needed
  if (!state.responseId) {
    state.responseId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.chunkIndex = 0;
  }

  const eventType = data._eventType || data.event || "";

  // Handle different Kiro event types
  if (eventType === "assistantResponseEvent" || data.assistantResponseEvent) {
    const content = data.assistantResponseEvent?.content || data.content || "";
    if (!content) return null;

    const openaiChunk = buildChunk(chunkMeta(state), {
      ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
      content: content
    }, null);

    state.chunkIndex++;
    return openaiChunk;
  }

  // Handle reasoning/thinking events.
  // Kiro emits reasoningContentEvent when the request enabled thinking via
  // the <thinking_mode>enabled</thinking_mode> system-prompt tag. We surface
  // this as OpenAI delta.reasoning_content so downstream translators can map
  // it to Claude thinking blocks / Anthropic reasoning / etc.
  if (eventType === "reasoningContentEvent" || data.reasoningContentEvent) {
    const reasoning = data.reasoningContentEvent || data;
    const content = (typeof reasoning === "string")
      ? reasoning
      : (reasoning.text || reasoning.content || data.content || "");
    if (!content) return null;

    const openaiChunk = buildChunk(chunkMeta(state), reasoningDelta(content, state.chunkIndex === 0), null);

    state.chunkIndex++;
    return openaiChunk;
  }

  // Handle tool use events
  if (eventType === "toolUseEvent" || data.toolUseEvent) {
    state.hadToolUse = true;
    const toolUse = data.toolUseEvent || data;
    const toolCallId = toolUse.toolUseId || fallbackToolCallId(state.toolCallIndex || 0);
    const toolName = toolUse.name || "";
    const toolInput = toolUse.input || {};

    // Stable per-stream index so multi-tool reassembly doesn't collide on 0 (wave9).
    if (typeof state.toolCallIndex !== "number") state.toolCallIndex = 0;
    if (!state.toolIdToIndex) state.toolIdToIndex = new Map();
    let idx = state.toolIdToIndex.get(toolCallId);
    if (idx === undefined) {
      idx = state.toolCallIndex++;
      state.toolIdToIndex.set(toolCallId, idx);
    }

    // String inputs pass through byte-identical; objects stringify once.
    const toolArgs = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);
    const openaiChunk = buildChunk(chunkMeta(state), {
      ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
      tool_calls: [{
        index: idx,
        id: toolCallId,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: toolName,
          arguments: toolArgs
        }
      }]
    }, null);

    state.chunkIndex++;
    return openaiChunk;
  }

  // Handle completion/done events. Raw Kiro ordering puts usage AFTER stop,
  // so defer the finish until usage arrives (or flush) instead of emitting a
  // usage-less terminal chunk.
  if (eventType === "messageStopEvent" || eventType === "done" || data.messageStopEvent) {
    // tool_calls when a tool was used this turn, else stop (kiro upstream has no explicit reason)
    const finishReason = toOpenAIFinish(state.hadToolUse ? "tool_use" : "stop", "kiro");
    state.finishReason = finishReason; // Mark for usage injection in stream.js

    if (!state.usage) {
      state.pendingFinish = finishReason;
      return null;
    }
    state.finishEmitted = true;
    const openaiChunk = buildChunk(chunkMeta(state), {}, finishReason);

    // Include usage in final chunk if available
    if (state.usage && typeof state.usage === "object") {
      openaiChunk.usage = state.usage;
    }

    return openaiChunk;
  }

// Handle usage events
  if (eventType === "usageEvent" || data.usageEvent) {
    const usage = toOpenAIUsage(data.usageEvent || data, "kiro");
    if (usage) state.usage = usage;
    // A deferred stop was waiting on this usage — emit the finish now.
    if (state.pendingFinish && !state.finishEmitted) {
      state.finishEmitted = true;
      const pending = buildChunk(chunkMeta(state), {}, state.pendingFinish);
      if (state.usage && typeof state.usage === "object") pending.usage = state.usage;
      state.pendingFinish = null;
      return pending;
    }
    return null;
  }

  // Web-search citations / supplementary links → appended markdown.
  if (eventType === "supplementaryWebLinksEvent" || data.supplementaryWebLinksEvent) {
    const payload = data.supplementaryWebLinksEvent || data;
    const links = Array.isArray(payload?.supplementaryWebLinks)
      ? payload.supplementaryWebLinks
      : (Array.isArray(payload?.links) ? payload.links : []);
    if (links.length === 0) return null;
    const markdown = links
      .map((l) => {
        const url = typeof l === "string" ? l : (l?.url || "");
        const title = typeof l === "string" ? l : (l?.title || url);
        return url ? `[${title}](${url})` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!markdown) return null;
    const openaiChunk = buildChunk(chunkMeta(state), {
      ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
      content: markdown
    }, null);
    state.chunkIndex++;
    return openaiChunk;
  }

  // Raw code events (non-executor callers) → plain content fallback.
  if (eventType === "codeEvent" || data.codeEvent) {
    const payload = data.codeEvent || data;
    const code = payload?.content || payload?.code || payload?.text || "";
    if (!code) return null;
    const openaiChunk = buildChunk(chunkMeta(state), {
      ...(state.chunkIndex === 0 ? { role: ROLE.ASSISTANT } : {}),
      content: code
    }, null);
    state.chunkIndex++;
    return openaiChunk;
  }

  // Unknown event type - skip
  return null;
}

// Register translator
register(FORMATS.KIRO, FORMATS.OPENAI, null, kiroToOpenAIResponse);
