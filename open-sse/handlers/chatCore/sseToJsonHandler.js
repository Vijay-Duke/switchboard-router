import { convertChatCompletionsStreamToJson, convertResponsesStreamToJson, parseChatCompletionsSSEToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { projectCompletionToClientFormat } from "../../translator/response/completionProjector.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "../../runtimeDeps.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  return parseChatCompletionsSSEToJson(rawSSE, fallbackModel);
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, requestId, clientRawRequest, onRequestSuccess, trackDone, appendLog }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    provider, model, connectionId,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // The parser is selected by the provider's wire format, not the client's.
  // A Responses API client can still be routed to a Chat Completions provider;
  // parsing that upstream SSE as Responses events produces an in_progress JSON
  // response with no output.
  if (isResponsesProvider(provider)) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      appendLog({ tokens: usage, status: "200 OK" });
      saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, requestId, endpoint: clientRawRequest?.endpoint });

      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const totalLatency = Date.now() - requestStartTime;

      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 },
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(jsonResponse), { headers: { "Content-Type": "application/json" } }) };
      }

      // Build OpenAI completion then project to client format (preserves tool_calls
      // for Gemini/Claude/Ollama — old path dropped them). PR#2348 / #2347.
      const inTokens = usage.input_tokens || 0;
      const outTokens = usage.output_tokens || 0;
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;
      const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
      const finishReason = hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop"));
      const openAICompletion = {
        id: jsonResponse.id || `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
        model: jsonResponse.model || model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: textContent || (hasToolCalls ? null : ""),
            ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        }],
        usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens }
      };
      const finalResp = projectCompletionToClientFormat(openAICompletion, sourceFormat);

      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json" } }) };
    } catch (err) {
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
    }
  }

  // Standard Chat Completions SSE path
  try {
    const parsed = await convertChatCompletionsStreamToJson(providerResponse.body, model);
    if (!parsed) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");

    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, requestId, endpoint: clientRawRequest?.endpoint });

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

    // Strip reasoning_content only when content is non-empty.
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    // Project OpenAI completion into the client's native format (Claude/Gemini/Ollama/…).
    // Without this, non-streaming clients received raw OpenAI JSON (#2347).
    const finalResp = projectCompletionToClientFormat(parsed, sourceFormat);

    return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json" } }) };
  } catch (err) {
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON");
  }
}
