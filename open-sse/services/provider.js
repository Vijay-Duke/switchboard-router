import { PROVIDERS } from "../config/providers.js";
import { OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: OPENAI_COMPAT_BASE,
};

const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: ANTHROPIC_COMPAT_BASE,
};

function isOpenAICompatible(provider) {
  return typeof provider === "string" && provider.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

function isAnthropicCompatible(provider) {
  return typeof provider === "string" && provider.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
}

export function resolveOpenAICompatibleApiType(provider, credentials = null) {
  if (!isOpenAICompatible(provider)) return "chat";

  // Persisted node metadata wins so custom/imported models keep the transport
  // that was saved with the provider connection; legacy ID is the fallback.
  const savedApiType = credentials?.providerSpecificData?.apiType;
  if (savedApiType === "chat" || savedApiType === "responses") {
    return savedApiType;
  }

  return provider.includes("responses") ? "responses" : "chat";
}

// Detect request format from body structure
export function detectFormat(body) {
  // OpenAI Responses API: has input (array or string) instead of messages[]
  // The Responses API accepts both input as array and input as a plain string
  if (body.input && (Array.isArray(body.input) || typeof body.input === "string") && !body.messages) {
    return "openai-responses";
  }

  // Antigravity format: Gemini wrapped in body.request
  if (body.request?.contents && body.userAgent === "antigravity") {
    return "antigravity";
  }

  // Gemini format: has contents array
  if (body.contents && Array.isArray(body.contents)) {
    return "gemini";
  }

  // OpenAI-specific indicators (check BEFORE Claude)
  // These fields are OpenAI-specific and never appear in Claude format
  if (
    body.stream_options ||           // OpenAI streaming options
    body.response_format ||           // JSON mode, etc.
    body.logprobs !== undefined ||    // Log probabilities
    body.top_logprobs !== undefined ||
    body.n !== undefined ||           // Number of completions
    body.presence_penalty !== undefined ||  // Penalties
    body.frequency_penalty !== undefined ||
    body.logit_bias ||                // Token biasing
    body.user                         // User identifier
  ) {
    return "openai";
  }

  // Claude format: messages with content as array of objects with type
  // Claude requires content to be array with specific structure.
  // Scan EVERY message: Claude markers (tool_use blocks, base64 image sources)
  // can appear in any turn, not just messages[0].
  if (body.messages && Array.isArray(body.messages)) {
    if (!body.model?.includes("/")) {
      let hasClaudeImage = false;
      let hasOpenAIImage = false;
      let hasClaudeTool = false;
      for (const msg of body.messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        for (const c of msg.content) {
          if (!c || typeof c !== "object") continue;
          // Claude format has specific types: text, image, tool_use, tool_result
          // OpenAI multimodal has: text, image_url (note the difference)
          if (c.type === "image" && c.source?.type === "base64") hasClaudeImage = true;
          else if (c.type === "image_url" && c.image_url?.url) hasOpenAIImage = true;
          else if (c.type === "tool_use" || c.type === "tool_result") hasClaudeTool = true;
        }
      }
      // Check if image format is Claude (source.type) vs OpenAI (image_url.url)
      if (hasClaudeImage) return "claude";
      if (hasOpenAIImage) return "openai";
      // If still unclear, check for tool format
      if (hasClaudeTool) return "claude";
    }

    // If content is string, it's likely OpenAI (Claude also supports this)
    // Check for other Claude-specific indicators
    if (body.system !== undefined || body.anthropic_version) {
      return "claude";
    }
  }

  // Default to OpenAI format
  return "openai";
}

// Get provider config (internal — no external runtime consumer)
function getProviderConfig(provider, credentials = null) {
  if (isOpenAICompatible(provider)) {
    const apiType = resolveOpenAICompatibleApiType(provider, credentials);
    return {
      ...PROVIDERS.openai,
      format: apiType === "responses" ? "openai-responses" : "openai",
      baseUrl: OPENAI_COMPATIBLE_DEFAULTS.baseUrl,
    };
  }
  if (isAnthropicCompatible(provider)) {
    return {
      ...PROVIDERS.anthropic, // Use Anthropic defaults (header: x-api-key)
      format: "claude",
      baseUrl: ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl,
    };
  }
  return PROVIDERS[provider] || PROVIDERS.openai;
}

// Get target format for provider
export function getTargetFormat(provider, credentials = null) {
  if (isOpenAICompatible(provider)) {
    return resolveOpenAICompatibleApiType(provider, credentials) === "responses" ? "openai-responses" : "openai";
  }
  if (isAnthropicCompatible(provider)) {
    return "claude";
  }
  const config = getProviderConfig(provider, credentials);
  return config.format || "openai";
}

// Resolve which transport to use for a provider given the client sourceFormat.
// Multi-endpoint providers (transport.transports[]) pick the entry matching sourceFormat
// to avoid lossy translation; falls back to the default transport when no match.
export function resolveTransport(provider, sourceFormat, supportedFormats = null) {
  if (Array.isArray(supportedFormats) && !supportedFormats.includes(sourceFormat)) return null;
  const config = PROVIDERS[provider];
  const transports = config?.transports;
  if (!Array.isArray(transports) || !transports.length) return null;
  return transports.find(t => t.format === sourceFormat) || null;
}

// Check if last message is from user
export function isLastMessageFromUser(body) {
  const messages = body.messages || body.contents;
  if (!messages?.length) return true;
  const lastMsg = messages[messages.length - 1];
  return lastMsg?.role === "user";
}

// Check if request has thinking config
export function hasThinkingConfig(body) {
  return !!(body.reasoning_effort || body.thinking?.type === "enabled");
}

// Normalize provider-native thinking config based on last message role.
// OpenAI reasoning_effort is request-level and must survive tool-result turns.
export function normalizeThinkingConfig(body) {
  if (!isLastMessageFromUser(body)) {
    delete body.thinking;
  }
  return body;
}
