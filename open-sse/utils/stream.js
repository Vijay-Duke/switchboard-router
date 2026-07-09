import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "../runtimeDeps.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";
import { createThinkExtractor } from "./thinkExtractor.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush

  // State for extracting <think>...</think> to reasoning_content across SSE chunks
  // (MiniMax M3 and similar OpenAI-format tiers). See PR#2463.
  const extractThink = createThinkExtractor();

  function trackSSELineStats(trimmed) {
    if (isDebugEnabled && trimmed) {
      sseLineCount++;
      if (trimmed.startsWith("event:")) {
        const evt = trimmed.slice(6).trim();
        eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
      }
    }
  }

  function normalizePassthroughEvent(lines) {
    return lines.map(line => {
      if (line.startsWith("data:") && !line.startsWith("data: ")) {
        return "data: " + line.slice(5);
      }
      return line;
    }).join("\n") + "\n\n";
  }

  function processPassthroughEvent(eventText, controller) {
    if (!eventText.trim()) return;

    const lines = eventText.split(/\r?\n/);
    for (const line of lines) trackSSELineStats(line.trim());

    const dataLines = lines.filter(line => line.startsWith("data:"));
    const dataText = dataLines.map(line => line.slice(5).replace(/^ /, "")).join("\n");
    let output;
    let injectedUsage = false;

    if (dataLines.length > 0) {
      if (dataText.trim() === "[DONE]") {
        if (streamDoneSent) return;
        streamDoneSent = true;
        output = "data: [DONE]\n\n";
      } else {
        try {
          const parsed = JSON.parse(dataText.trim());

          const idFixed = fixInvalidId(parsed);

          // Decloak tool names in Claude content_block_start events.
          // claude→claude passthrough skips translateResponse (which applies
          // toolNameMap in TRANSLATE mode), so without this the client gets
          // suffixed OAuth names (e.g. "Execute_ide"). decolua/9router#2391 / PR#2392.
          let toolNameDecloaked = false;
          if (toolNameMap?.size > 0 && parsed?.type === "content_block_start" && parsed?.content_block?.type === "tool_use") {
            const original = toolNameMap.get(parsed.content_block.name);
            if (original) {
              parsed.content_block = { ...parsed.content_block, name: original };
              toolNameDecloaked = true;
            }
          }

          // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
          let fieldsInjected = false;
          if (parsed.choices !== undefined) {
            if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
            if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
          }

          // Strip Azure-specific non-standard fields from streaming chunks
          if (parsed.prompt_filter_results !== undefined) {
            delete parsed.prompt_filter_results;
            fieldsInjected = true;
          }
          if (parsed?.choices) {
            for (const choice of parsed.choices) {
              if (choice.content_filter_results !== undefined) {
                delete choice.content_filter_results;
                fieldsInjected = true;
              }
            }
          }

          // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
          // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
          // every streaming delta. @ai-sdk/openai-compatible checks
          // `delta.tool_calls != null` — an empty array passes this check,
          // causing premature `reasoning-end` on every chunk.
          if (parsed?.choices) {
            for (const choice of parsed.choices) {
              if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                delete choice.delta.tool_calls;
                fieldsInjected = true;
              }
            }
          }

          if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
            return;
          }

          const delta = parsed.choices?.[0]?.delta;

          // Extract <think>...</think> from content into reasoning_content.
          // MiniMax M3 on OpenAI-format provider tiers embeds thinking as XML
          // tags inside `content` instead of a separate `reasoning_content`.
          if (typeof delta?.content === "string") {
            const { content: textOut, reasoning: thinkOut } = extractThink(delta.content);
            if (thinkOut) {
              delta.reasoning_content = (delta.reasoning_content || "") + thinkOut;
            }
            if (textOut !== delta.content) {
              if (delta.reasoning_content && (!textOut || !textOut.trim())) {
                delete delta.content;
              } else {
                delta.content = textOut || "";
              }
              fieldsInjected = true;
            }
          }

          const content = delta?.content;
          const reasoning = delta?.reasoning_content;
          if (content && typeof content === "string") {
            totalContentLength += content.length;
            accumulatedContent += content;
          }
          if (reasoning && typeof reasoning === "string") {
            totalContentLength += reasoning.length;
            accumulatedThinking += reasoning;
          }

          const extracted = extractUsage(parsed);
          if (extracted) {
            usage = mergeUsage(usage, extracted);
          }

          const isFinishChunk = parsed.choices?.[0]?.finish_reason;
          if (isFinishChunk && !hasValidUsage(parsed.usage)) {
            const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
            parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
            output = `data: ${JSON.stringify(parsed)}\n\n`;
            usage = estimated;
            injectedUsage = true;
          } else if (isFinishChunk && usage) {
            const buffered = addBufferToUsage(usage);
            parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
            output = `data: ${JSON.stringify(parsed)}\n\n`;
            injectedUsage = true;
          } else if (idFixed || fieldsInjected || toolNameDecloaked) {
            output = `data: ${JSON.stringify(parsed)}\n\n`;
            injectedUsage = true;
          }
        } catch {
          // Skip non-JSON data events silently — don't forward garbage to clients.
          // Upstream providers sometimes return plain-text errors (HTML, rate-limit
          // messages) in the SSE stream that would break downstream JSON decoders.
          return;
        }
      }
    }

    if (!injectedUsage && !output) {
      output = normalizePassthroughEvent(lines);
    }

    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
  }

  function drainPassthroughEvents(controller, force = false) {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const eventText of events) processPassthroughEvent(eventText, controller);
    if (force && buffer) {
      processPassthroughEvent(buffer, controller);
      buffer = "";
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      if (mode === STREAM_MODE.PASSTHROUGH) {
        drainPassthroughEvents(controller);
        return;
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        trackSSELineStats(trimmed);

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // Extract <think> tags on OpenAI-shaped provider chunks before translation
        // (PASSTHROUGH already does this; TRANSLATE path was missing it — wave9).
        if (typeof parsed?.choices?.[0]?.delta?.content === "string") {
          const delta = parsed.choices[0].delta;
          const { content: textOut, reasoning: thinkOut } = extractThink(delta.content);
          if (thinkOut) {
            delta.reasoning_content = (delta.reasoning_content || "") + thinkOut;
          }
          if (textOut !== delta.content) {
            if (delta.reasoning_content && (!textOut || !textOut.trim())) {
              delete delta.content;
            } else {
              delta.content = textOut || "";
            }
          }
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          drainPassthroughEvents(controller, true);

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking
            }, usage, ttftAt);
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
