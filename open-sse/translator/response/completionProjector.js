import { FORMATS } from "../formats.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { GEMINI_FINISH, OPENAI_FINISH } from "../schema/finishReasons.js";

function parseArgs(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getChoice(completion) {
  return completion?.choices?.[0] || {};
}

function getMessage(completion) {
  return getChoice(completion).message || {};
}

function getToolCalls(completion) {
  const calls = getMessage(completion).tool_calls;
  return Array.isArray(calls) ? calls : [];
}

// Thread cache + reasoning usage details through projections (both OpenAI and
// Claude-side detail keys) instead of dropping them to bare tokens.
function projectUsage(usage) {
  const u = usage || {};
  const promptTokens = u.prompt_tokens || u.input_tokens || 0;
  const completionTokens = u.completion_tokens || u.output_tokens || 0;
  const out = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: u.total_tokens || (promptTokens + completionTokens),
  };
  // Accept OpenAI (prompt_tokens_details), Responses (input_tokens_details),
  // and Claude-side (cache_read_input_tokens) detail keys.
  const promptDetails = u.prompt_tokens_details || {};
  const inputDetails = u.input_tokens_details || {};
  const cachedTokens = promptDetails.cached_tokens || inputDetails.cached_tokens || u.cache_read_input_tokens || 0;
  const cacheCreationTokens = promptDetails.cache_creation_tokens || inputDetails.cache_creation_tokens || u.cache_creation_input_tokens || 0;
  if (cachedTokens > 0 || cacheCreationTokens > 0) {
    out.prompt_tokens_details = {};
    if (cachedTokens > 0) out.prompt_tokens_details.cached_tokens = cachedTokens;
    if (cacheCreationTokens > 0) out.prompt_tokens_details.cache_creation_tokens = cacheCreationTokens;
  }
  const completionDetails = u.completion_tokens_details || {};
  const outputDetails = u.output_tokens_details || {};
  const reasoningTokens = completionDetails.reasoning_tokens || outputDetails.reasoning_tokens || 0;
  if (reasoningTokens > 0) {
    out.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return out;
}

function projectClaudeUsage(usage) {
  const u = usage || {};
  const promptTokens = u.prompt_tokens || u.input_tokens || 0;
  const completionTokens = u.completion_tokens || u.output_tokens || 0;
  const out = { input_tokens: promptTokens, output_tokens: completionTokens };
  const promptDetails = u.prompt_tokens_details || {};
  const inputDetails = u.input_tokens_details || {};
  const cacheRead = promptDetails.cached_tokens || inputDetails.cached_tokens || u.cache_read_input_tokens || 0;
  const cacheCreate = promptDetails.cache_creation_tokens || inputDetails.cache_creation_tokens || u.cache_creation_input_tokens || 0;
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheCreate > 0) out.cache_creation_input_tokens = cacheCreate;
  return out;
}

function openAIToGeminiFinish(reason) {
  switch (reason) {
    case OPENAI_FINISH.LENGTH: return GEMINI_FINISH.MAX_TOKENS;
    case OPENAI_FINISH.CONTENT_FILTER: return GEMINI_FINISH.SAFETY;
    case OPENAI_FINISH.ERROR: return GEMINI_FINISH.MALFORMED_FUNCTION_CALL;
    default: return GEMINI_FINISH.STOP;
  }
}

function openAICompletionToClaudeMessage(completion) {
  if (!completion?.choices?.[0]) return completion;
  const choice = getChoice(completion);
  const message = getMessage(completion);
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of getToolCalls(completion)) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseArgs(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = completion.usage || {};
  return {
    id: String(completion.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: completion.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: projectClaudeUsage(usage),
  };
}

function openAICompletionToGeminiResponse(completion) {
  if (!completion?.choices?.[0]) return completion;
  const message = getMessage(completion);
  const usage = projectUsage(completion.usage || {});
  const parts = [];
  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ text: message.content });
  }
  for (const toolCall of getToolCalls(completion)) {
    const fn = toolCall.function || {};
    parts.push({
      functionCall: {
        name: fn.name || toolCall.name || "",
        args: parseArgs(fn.arguments || toolCall.arguments),
      }
    });
  }
  if (parts.length === 0) parts.push({ text: "" });

  return {
    response: {
      candidates: [{
        content: { role: "model", parts },
        finishReason: openAIToGeminiFinish(getChoice(completion).finish_reason),
        index: 0
      }],
      usageMetadata: {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens,
      },
      modelVersion: completion.model || "unknown",
      responseId: completion.id || `resp_${Date.now()}`
    }
  };
}

function openAICompletionToOllama(completion) {
  if (!completion?.choices?.[0]) return completion;
  const choice = getChoice(completion);
  const message = getMessage(completion);
  const ollamaMessage = {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
  };
  if (message.reasoning_content) ollamaMessage.thinking = message.reasoning_content;
  const toolCalls = getToolCalls(completion).map((toolCall) => {
    const fn = toolCall.function || {};
    return {
      id: toolCall.id,
      function: {
        name: fn.name || toolCall.name || "",
        arguments: parseArgs(fn.arguments || toolCall.arguments),
      }
    };
  });
  if (toolCalls.length > 0) ollamaMessage.tool_calls = toolCalls;

  const usage = completion.usage || {};
  return {
    model: completion.model || "unknown",
    created_at: completion.created ? new Date(completion.created * 1000).toISOString() : new Date().toISOString(),
    message: ollamaMessage,
    done: true,
    // Ollama's done_reason has no tool_calls value — hub tool turns are plain stops.
    done_reason: choice.finish_reason === "tool_calls" ? "stop" : (choice.finish_reason || "stop"),
    prompt_eval_count: usage.prompt_tokens || usage.input_tokens || 0,
    eval_count: usage.completion_tokens || usage.output_tokens || 0,
  };
}

export function responsesApiToOpenAICompletion(responseBody, fallbackModel) {
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  const reasoningText = output
    .filter(item => item?.type === "reasoning")
    .flatMap(item => Array.isArray(item.summary) ? item.summary : [])
    .map(part => part?.text || "")
    .join("");
  const messages = output.filter(item => item?.type === "message");
  const msgItem = [...messages].reverse().find(item => {
    const content = Array.isArray(item.content) ? item.content : [];
    return content.some(part => typeof part.text === "string" && part.text.length > 0);
  }) || messages[messages.length - 1] || null;
  const refusalText = output
    .filter(item => item?.type === "refusal")
    .map(item => item?.refusal || "")
    .join("");
  const textContent = (Array.isArray(msgItem?.content) ? msgItem.content : [])
    .map(part => part.type === "output_text" || part.type === "refusal" || typeof part.text === "string"
      ? part.text || part.refusal || ""
      : "")
    .join("") || refusalText;
  const toolCalls = output
    .filter(item => item?.type === "function_call" || item?.type === "custom_tool_call")
    .map((item, idx) => ({
      id: item.call_id || `call_${item.name || "tool"}_${idx}`,
      type: "function",
      function: {
        name: item.name || "",
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? item.input ?? {}),
      },
    }));

  const usage = responseBody?.usage || {};
  const message = {
    role: "assistant",
    content: textContent || (toolCalls.length > 0 ? null : ""),
  };
  if (reasoningText) message.reasoning_content = reasoningText;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  // Map Responses statuses to valid OpenAI finish_reasons (never echo raw).
  let finishReason;
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  } else if (refusalText && textContent.split(refusalText).join("").trim() === "") {
    finishReason = "content_filter";
  } else {
    const status = responseBody?.status;
    if (status === "completed" || status === "done") finishReason = "stop";
    else if (status === "failed") finishReason = "error";
    else if (status === "incomplete") {
      finishReason = responseBody?.incomplete_details?.reason === "content_filter"
        ? "content_filter"
        : "length";
    } else finishReason = "stop";
  }
  return {
    id: responseBody?.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responseBody?.created_at || Math.floor(Date.now() / 1000),
    model: responseBody?.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: projectUsage(usage),
  };
}

function openAICompletionToResponsesOutput(completion) {
  if (!completion?.choices?.[0]) return completion;
  const message = getMessage(completion);
  const usage = completion.usage || {};
  const output = [];
  let idx = 0;

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `rs_${completion.id || Date.now()}_${idx}`,
      summary: [{ type: "summary_text", text: reasoning }],
    });
    idx++;
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    output.push({
      type: "message",
      id: `msg_${completion.id || Date.now()}_${idx}`,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    });
    idx++;
  }

  const toolCalls = getToolCalls(completion);
  if (toolCalls.length > 0) {
    for (const toolCall of toolCalls) {
      const fn = toolCall.function || {};
      const callId = toolCall.id || `call_${fn.name || "tool"}_${idx}`;
      output.push({
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name: fn.name || toolCall.name || "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
      });
      idx++;
    }
  } else if (!text && !reasoning) {
    output.push({
      type: "message",
      id: `msg_${completion.id || Date.now()}_${idx}`,
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
    });
  }

  const finishReason = getChoice(completion).finish_reason || "stop";
  // Map hub finish reasons to valid Responses statuses (never echo raw).
  let status = "completed";
  let incompleteDetails;
  if (finishReason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  } else if (finishReason === "content_filter") {
    status = "incomplete";
    incompleteDetails = { reason: "content_filter" };
  } else if (finishReason === "error") {
    status = "failed";
  }
  const projected = projectUsage(usage);
  return {
    id: completion.id ? `resp_${completion.id}` : `resp_${Date.now()}`,
    object: "response",
    created_at: completion.created || Math.floor(Date.now() / 1000),
    status,
    ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
    output,
    usage: {
      input_tokens: projected.prompt_tokens,
      output_tokens: projected.completion_tokens,
      total_tokens: projected.total_tokens,
    },
  };
}

export function projectCompletionToClientFormat(completion, sourceFormat) {
  switch (sourceFormat) {
    case FORMATS.CLAUDE:
      return openAICompletionToClaudeMessage(completion);
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.ANTIGRAVITY:
    case FORMATS.VERTEX:
      return openAICompletionToGeminiResponse(completion);
    case FORMATS.OLLAMA:
      return openAICompletionToOllama(completion);
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
      return openAICompletionToResponsesOutput(completion);
    // Kiro, Cursor, and CommandCode all consume OpenAI-shaped JSON on their
    // non-streaming paths (their streaming translators pass OpenAI chunks
    // through as-is: kiro-to-openai, cursor-to-openai, commandcode-to-openai).
    // Returning the completion unchanged is intentional, not a gap.
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      return completion;
    default:
      return completion;
  }
}