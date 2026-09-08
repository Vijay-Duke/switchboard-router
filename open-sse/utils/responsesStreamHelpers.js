// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
// ("response.incomplete" = truncated turn, e.g. max_output_tokens / content_filter)
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed" || status === "incomplete";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Encoded terminal chunks for aborted/stalled chat-completions wire streams.
// finish_reason:"stream_timeout" so pi retries (isRetryableAssistantError matches
// /timeout/ on "Provider finish_reason: ${reason}"). Top-level error serves clients
// that surface chunk.error instead. Without this, stall aborts close with silent EOF.
export function buildAbortedChatCompletionsTerminalBytes() {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    // stream_timeout (not stream_stalled): pi throws "Provider finish_reason: ${reason}"
    // and only retries if that string matches /timeout/.
    choices: [{ index: 0, delta: {}, finish_reason: "stream_timeout" }],
    error: {
      message: "upstream stream stall timeout: aborted before completion",
      type: "server_error",
      code: "stream_stalled",
    },
  };
  return sharedEncoder.encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream timeout: closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
