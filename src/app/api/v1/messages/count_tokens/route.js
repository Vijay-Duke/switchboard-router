// @ts-check
import { parseModel } from "open-sse/services/model.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { ANTHROPIC_COMPAT_BASE } from "open-sse/providers/shared.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { pickClaudeIdentityHeaders } from "open-sse/utils/claudeIdentityHeaders.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// Image blocks carry no countable text (just a source pointer or URL), but
// still occupy context. Anthropic bills roughly ~1600 tokens per image, so
// the estimator uses the same flat rate instead of base64-length/4 (which
// wildly over-counts) or 0 (which under-counts).
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1600;
const COUNT_TOKENS_UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function countValueChars(value) {
  const pending = [value];
  let total = 0;

  while (pending.length) {
    const current = pending.pop();
    if (current == null) continue;
    if (typeof current === "string") {
      total += current.length;
      continue;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      total += String(current).length;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        total += key.length;
        pending.push(item);
      }
    }
  }

  return total;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);

  switch (block.type) {
    case "text":
      return countValueChars(block.text);
    case "tool_use":
      return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result":
      return countValueChars(block.content);
    case "thinking":
      return countValueChars(block.thinking);
    case "image":
    case "image_url":
      return IMAGE_BLOCK_TOKEN_ESTIMATE;
    default:
      // Image payloads nested under another shape still must not count
      // base64 bytes as text.
      if (typeof block.source?.data === "string" && block.source.media_type) {
        return IMAGE_BLOCK_TOKEN_ESTIMATE;
      }
      return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;

  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, block) => total + countContentBlockChars(block), 0);
  }
  return countValueChars(content);
}

export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);

  for (const msg of messages) {
    totalChars += countMessageChars(msg);
  }

  return Math.ceil(totalChars / 4);
}

/**
 * Resolve the provider for a count_tokens body. Prefixed "provider/model"
 * values parse without I/O; bare model names/aliases resolve through the
 * alias map (same getModelInfo path as the chat handler).
 * @returns {Promise<{ provider: string, model: string } | null>}
 */
async function resolveCountProvider(modelStr) {
  if (typeof modelStr !== "string" || !modelStr) return null;
  const parsed = parseModel(modelStr);
  if (!parsed.isAlias && parsed.provider) {
    return { provider: parsed.provider, model: parsed.model };
  }
  try {
    const { getModelInfo } = await import("@/sse/services/model.js");
    const info = await getModelInfo(modelStr);
    if (info?.provider) return { provider: info.provider, model: info.model };
  } catch {
    // Alias map unavailable — fall through to the estimator.
  }
  return null;
}

/**
 * Upstream count_tokens URL for a Claude-format provider. Registry chat
 * baseUrls end in /messages (append /count_tokens); compat-node bases end
 * in /v1 (append /messages/count_tokens).
 */
function resolveCountTokensUrl(provider, credentials) {
  let base;
  if (provider?.startsWith?.("anthropic-compatible-")) {
    base = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
  } else {
    base = PROVIDERS[provider]?.baseUrl || "";
  }
  base = String(base).split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (!base) return null;
  return base.endsWith("/messages") ? `${base}/count_tokens` : `${base}/messages/count_tokens`;
}

/**
 * Forward to the provider's own count_tokens endpoint when the resolved
 * provider speaks Claude format and credentials exist. Returns a Response on
 * success, null when the estimator should answer instead (non-Claude
 * provider, no credentials, or any upstream failure — fail open so context
 * meters and auto-compaction keep working degraded).
 */
async function tryProxyCountTokens(body, request, provider, bareModel) {
  const transport = PROVIDERS[provider];
  const format = transport?.format;
  if (format !== "claude" && !provider?.startsWith?.("anthropic-compatible-")) {
    return null;
  }

  const { getProviderCredentials } = await import("@/sse/services/auth.js");
  const credentials = await getProviderCredentials(provider);
  if (!credentials || credentials.allRateLimited) return null;
  if (!credentials.accessToken && !credentials.apiKey) return null;

  const url = resolveCountTokensUrl(provider, credentials);
  if (!url) return null;

  const { getExecutor } = await import("open-sse/executors/index.js");
  const executor = getExecutor(provider);
  // Same beta set the chat path sends for this model, so the count matches
  // what the real request will be billed against.
  const headers = executor.buildHeaders(credentials, false, url, bareModel || body.model);
  headers["Accept"] = "application/json";

  let rawHeaders = {};
  try {
    rawHeaders = Object.fromEntries(request.headers.entries());
  } catch {
    rawHeaders = {};
  }

  const response = await proxyAwareFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model: bareModel || body.model }),
    // Claude Code blocks on count_tokens; a hung upstream must fail over to
    // the estimator instead of stalling the client.
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(COUNT_TOKENS_UPSTREAM_TIMEOUT_MS)].filter(Boolean)),
    identity: executor.resolveIdentity(credentials),
    provider,
    format: credentials?.runtimeTransport?.format || transport?.format,
    overlay: pickClaudeIdentityHeaders(rawHeaders) || undefined,
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data || typeof data.input_tokens !== "number") return null;
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * POST /v1/messages/count_tokens - Proxy to the provider's endpoint when it
 * speaks Claude format, otherwise answer with the chars/4 estimator.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  try {
    const resolved = await resolveCountProvider(body.model);
    if (resolved) {
      const proxied = await tryProxyCountTokens(body, request, resolved.provider, resolved.model);
      if (proxied) return proxied;
    }
  } catch {
    // Fail open to the estimator below.
  }

  const inputTokens = estimateAnthropicInputTokens(body);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
