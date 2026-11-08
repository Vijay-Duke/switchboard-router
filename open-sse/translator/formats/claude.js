// Claude helper functions for translator
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { ROLE, CLAUDE_BLOCK } from "../schema/index.js";
import { adjustMaxTokens } from "./maxTokens.js";
import { applyCloaking } from "../../utils/claudeCloaking.js";
import { resolveSessionId } from "../../utils/sessionManager.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";
import { PROVIDERS } from "../../providers/index.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";

// "model(level)" is a thinking override suffix; strip before matching.
// Accepts both bare ids ("deepseek-v4-pro(max)") and provider-prefixed ones.
function isDeepSeekModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^deepseek-/i.test(base);
}

const CACHE_CONTROL_5M = { type: "ephemeral" };
const CACHE_CONTROL_1H = { type: "ephemeral", ttl: "1h" };

// Anthropic rejects a tool carrying BOTH defer_loading:true and cache_control
// ("Tools defer_loading cannot use prompt caching", #3567). MCP clients put
// deferred tools at the tail, which is exactly where the cache anchor lands.
// Anchor on the last tool that CAN be cached instead of dropping caching.
export function lastCacheableToolIndex(tools) {
  if (!Array.isArray(tools)) return -1;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i]?.defer_loading !== true) return i;
  }
  return -1;
}

// Some clients send content as a single block object instead of a one-element
// array; every leg that reads messages expects an array (or string), so the
// turn was dropped or zeroed. Wrap it, dropping any client marker on it.
export function normalizeMessageContent(msg) {
  const c = msg?.content;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    delete c.cache_control;
    msg.content = [c];
  }
  return msg;
}

// Check if message has valid non-empty content.
// A block type outside this list makes the whole message count as empty and be
// dropped by prepareClaudeRequest, so anything a caller can legitimately send
// alone must be listed. container_upload (Files API): a user turn whose only
// block is a file reference is valid Anthropic input (#4316).
const CONTENTFUL_BLOCKS = new Set([
  CLAUDE_BLOCK.TOOL_USE,
  CLAUDE_BLOCK.TOOL_RESULT,
  CLAUDE_BLOCK.IMAGE,
  CLAUDE_BLOCK.DOCUMENT,
  CLAUDE_BLOCK.CONTAINER_UPLOAD,
]);

function isContentfulBlock(block) {
  if (!block) return false;
  if (block.type === CLAUDE_BLOCK.TEXT) return !!block.text?.trim();
  return CONTENTFUL_BLOCKS.has(block.type);
}

export function hasValidContent(msg) {
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  if (Array.isArray(msg.content)) return msg.content.some(isContentfulBlock);
  if (msg.content && typeof msg.content === "object") return isContentfulBlock(msg.content);
  return false;
}

// Fix tool_use/tool_result ordering for Claude API
// 1. Assistant message with tool_use: remove text AFTER tool_use (Claude doesn't allow)
// 2. Merge consecutive same-role messages
export function fixToolUseOrdering(messages) {
  if (messages.length <= 1) return messages;

  // Pass 1: Fix assistant messages with tool_use - remove text after tool_use
  for (const msg of messages) {
    if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === CLAUDE_BLOCK.TOOL_USE);
      if (hasToolUse) {
        // Keep only: thinking blocks + tool_use blocks (remove text blocks after tool_use)
        const newContent = [];
        let foundToolUse = false;

        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            foundToolUse = true;
            newContent.push(block);
          } else if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
            newContent.push(block);
          } else if (!foundToolUse) {
            // Keep text blocks BEFORE tool_use
            newContent.push(block);
          }
          // Skip text blocks AFTER tool_use
        }

        msg.content = newContent;
      }
    }
  }

  // Pass 2: Merge consecutive same-role messages
  const merged = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];

    if (last && last.role === msg.role) {
      // Merge content arrays
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: CLAUDE_BLOCK.TEXT, text: last.content }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];

      // Put tool_result first, then other content
      const toolResults = [...lastContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT)];
      const otherContent = [...lastContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT)];

      last.content = [...toolResults, ...otherContent];
    } else {
      // Ensure content is array
      const content = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];
      merged.push({ role: msg.role, content: [...content] });
    }
  }

  return merged;
}

// Models that reject thinking.type "adaptive" + output_config.effort: legacy Haiku
// only. Haiku 5.5 supports adaptive thinking and all five effort levels, so it
// must pass through untouched.
const ADAPTIVE_THINKING_UNSUPPORTED = /haiku(?!-5-5)/i;

function handlesThinkingBlocks(provider) {
  // MiniMax Anthropic-compatible tiers also need thinking-block normalization (wave8).
  return provider === "claude"
    || provider?.startsWith("anthropic-compatible")
    || provider === "deepseek"
    || provider === "minimax"
    || provider === "minimax-cn";
}

// Redacted thinking carries opaque encrypted data, not a regular thinking
// signature. Both shapes must survive an ongoing tool-use turn unchanged.
function isReusableClaudeThinkingBlock(block) {
  if (block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
    return typeof block.data === "string" && block.data.length > 0;
  }
  return isValidClaudeSignature(block.signature);
}

function buildThinkingPlaceholder(provider, unsigned = false) {
  const block = {
    type: CLAUDE_BLOCK.THINKING,
    thinking: ".",
  };

  // DeepSeek's Anthropic-compatible endpoint requires a thinking block in
  // thinking mode, but it does not need Anthropic's signed-thinking fallback.
  // The same applies to DeepSeek models served through other providers'
  // Claude transports (opencode-go /messages).
  if (provider !== "deepseek" && !unsigned) {
    block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
  }

  return block;
}

// Anthropic validates server_tool_use ids against this pattern and rejects the
// whole request with a 400 when one does not match. A combo that falls back to a
// provider with its own built-in tools (z.ai/glm emits OpenAI-style `call_` ids for
// its analyze_image tool) leaves such blocks in the history, so every later Claude
// turn carries a poisoned id.
const CLAUDE_SERVER_TOOL_USE_ID = /^srvtoolu_[a-zA-Z0-9_]+$/;

function hasForeignServerToolUseId(block) {
  return block?.type === CLAUDE_BLOCK.SERVER_TOOL_USE
    && !CLAUDE_SERVER_TOOL_USE_ID.test(String(block.id ?? ""));
}

// Normalize a native Claude passthrough body to match Anthropic Messages API spec.
// Newer Cowork/Claude Code clients emit beta-only shapes that OAuth endpoints reject:
// 1. thinking.type "adaptive" → unsupported on Haiku
// 2. output_config.effort → unsupported on Haiku
// 3. role "system" messages (mid-conversation-system beta) → only top-level system is allowed
// 4. server_tool_use blocks carrying a foreign (non-srvtoolu_) id → rejected outright
export function normalizeClaudePassthrough(body, model = "") {
  if (!body || typeof body !== "object") return body;

  // 1. Downgrade adaptive thinking for models that don't support it
  if (body.thinking?.type === "adaptive" && ADAPTIVE_THINKING_UNSUPPORTED.test(model)) {
    body.thinking = { type: "enabled", budget_tokens: 10000 };
  }

  // 2. Strip effort param for models that don't support it (keep other output_config fields)
  if (ADAPTIVE_THINKING_UNSUPPORTED.test(model) && body.output_config?.effort != null) {
    // Native passthrough starts with a shallow body copy. Keep the shared
    // request's effort intact for a subsequent model/account fallback.
    const { effort, ...outputConfig } = body.output_config;
    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
    else delete body.output_config;
  }

  const originalLastRole = Array.isArray(body.messages) ? body.messages[body.messages.length - 1]?.role : undefined;

  // Bare-object content → one-block array before the fold below reads it.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) normalizeMessageContent(msg);
  }

  // 2. Fold mid-conversation system messages into the neighbouring turn.
  // Hoisting them into body.system would insert volatile content (token counters,
  // reminders) ahead of the whole conversation and invalidate the prefix cache on
  // every request. Folding in place keeps the cached prefix stable.
  if (Array.isArray(body.messages)) {
    const messages = [];
    for (const msg of body.messages) {
      if (msg.role !== ROLE.SYSTEM) {
        messages.push(msg);
        continue;
      }
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n")
          : "";
      if (!text.trim()) continue;

      // Copy-on-write: the caller's body is reused across account-fallback
      // attempts, so folding must never mutate the original message.
      const block = { type: CLAUDE_BLOCK.TEXT, text };
      const prev = messages[messages.length - 1];
      if (prev?.role === ROLE.USER) {
        const content = typeof prev.content === "string"
          ? [{ type: CLAUDE_BLOCK.TEXT, text: prev.content }]
          : Array.isArray(prev.content) ? [...prev.content] : [];
        messages[messages.length - 1] = { ...prev, content: [...content, block] };
        continue;
      }
      messages.push({ role: ROLE.USER, content: [block] });
    }
    // Anthropic merges adjacent user turns. Keep tool results at the beginning
    // of that merged turn, even when a folded system reminder precedes them.
    // Preserve actual results; never invent a successful tool execution.
    const merged = [];
    const hasToolUse = (message) => message?.role === ROLE.ASSISTANT
      && Array.isArray(message.content)
      && message.content.some(block => block.type === CLAUDE_BLOCK.TOOL_USE);
    for (const msg of messages) {
      const previous = merged[merged.length - 1];
      if (previous?.role === ROLE.USER && msg.role === ROLE.USER
        && hasToolUse(merged[merged.length - 2])) {
        const asBlocks = (content) => Array.isArray(content)
          ? content : [{ type: CLAUDE_BLOCK.TEXT, text: content }];
        merged[merged.length - 1] = {
          ...previous,
          content: [...asBlocks(previous.content), ...asBlocks(msg.content)],
        };
      } else {
        // The original message objects can be reused by account fallback.
        merged.push({ ...msg });
      }
    }
    for (let i = 1; i < merged.length; i++) {
      const msg = merged[i];
      const previous = merged[i - 1];
      if (msg.role !== ROLE.USER || !Array.isArray(msg.content)
        || !hasToolUse(previous)) continue;
      const results = msg.content.filter(block => block.type === CLAUDE_BLOCK.TOOL_RESULT);
      if (results.length > 0) {
        msg.content = [
          ...results,
          ...msg.content.filter(block => block.type !== CLAUDE_BLOCK.TOOL_RESULT),
        ];
      }
    }
    body.messages = merged;
  }

  // 3. Drop thinking blocks whose signature is not Claude's (combo mixes models,
  // so foreign signatures leak into history and Anthropic rejects them).
  const thinkingEnabled = body.thinking?.type === "enabled";
  const droppedServerToolUseIds = new Set();
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role !== ROLE.ASSISTANT || !Array.isArray(msg.content)) continue;
      let hasToolUse = false;
      let hasKeptThinking = false;
      const kept = [];
      for (const block of msg.content) {
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
          if (isReusableClaudeThinkingBlock(block)) {
            hasKeptThinking = true;
            kept.push(block);
          }
          continue;
        }
        if (hasForeignServerToolUseId(block)) {
          if (block.id != null) droppedServerToolUseIds.add(String(block.id));
          continue;
        }
        if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
        kept.push(block);
      }
      msg.content = kept;
      if (thinkingEnabled && !hasKeptThinking && hasToolUse) {
        msg.content.unshift(buildThinkingPlaceholder("claude"));
      }
    }
  }

  // A dropped server_tool_use leaves its result behind; Anthropic rejects a
  // tool_result that references an id no block declares, so both halves must go.
  if (droppedServerToolUseIds.size > 0 && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg.content)) continue;
      const kept = msg.content.filter(block => !(
        (block?.type === CLAUDE_BLOCK.TOOL_RESULT || block?.type === CLAUDE_BLOCK.WEB_SEARCH_TOOL_RESULT)
        && droppedServerToolUseIds.has(String(block.tool_use_id ?? ""))
      ));
      if (kept.length !== msg.content.length) {
        msg.content = kept;
      }
    }
  }

  // 5. Drop empty text blocks and any message left with no content at all.
  // Anthropic rejects `messages.N.content` blocks with empty text (400
  // "text content blocks must be non-empty"); a message whose blocks were all
  // stripped above must be dropped, not padded with an empty placeholder.
  // The same applies to thinking blocks: Anthropic rejects a block with no visible
  // text (400 "each thinking block must contain non-whitespace thinking"), and such
  // a block rides along in the client's replayed history on every later turn.
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.filter(msg => {
      if (typeof msg.content === "string") return msg.content.trim().length > 0;
      if (!Array.isArray(msg.content)) return true;
      msg.content = msg.content.filter(block =>
        !(block?.type === CLAUDE_BLOCK.TEXT && !String(block.text ?? "").trim())
        && !(block?.type === CLAUDE_BLOCK.THINKING && !String(block.thinking ?? "").trim()));
      return msg.content.length > 0;
    });
    body.messages = ensureTrailingUserTurn(body.messages, originalLastRole);
  }

  return body;
}

// Newer Claude models reject a body that ends on an assistant turn (prefill).
// Empty-turn cleanup can drop the client's final user turn and leave the
// previous assistant turn last; restore a minimal user turn then. A client that
// itself ended on assistant (intentional prefill) is left alone.
const TRAILING_USER_PLACEHOLDER = "Continue.";

export function ensureTrailingUserTurn(messages, originalLastRole) {
  if (!Array.isArray(messages) || originalLastRole === ROLE.ASSISTANT) return messages;
  if (messages[messages.length - 1]?.role !== ROLE.ASSISTANT) return messages;
  return [...messages, { role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TEXT, text: TRAILING_USER_PLACEHOLDER }] }];
}

// Put a 5m breakpoint on the last cache-eligible block of a message.
// thinking/redacted_thinking blocks do not accept cache_control.
function markLastCacheableBlock(msg) {
  if (!Array.isArray(msg?.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const block = msg.content[i];
    if (typeof block !== "object" || block === null) continue;
    if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) continue;
    block.cache_control = { ...CACHE_CONTROL_5M };
    return true;
  }
  return false;
}

// Total blocks carrying cache_control across system, tools, and messages — the
// Messages API allows at most 4 markers per request.
function countCacheControlBlocks(body) {
  let n = 0;
  const count = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) if (item && typeof item === "object" && item.cache_control) n++;
  };
  count(body?.system);
  count(body?.tools);
  if (Array.isArray(body?.messages)) for (const msg of body.messages) count(msg?.content);
  return n;
}

// In an agent's tool loop a request ends with the results of the last
// assistant turn's tool calls — after that turn's breakpoint, so they bill as
// uncached input and only the next request writes them. When the 4-marker
// budget has room, a 5m breakpoint on that final user turn caches them now.
function markFinalToolResults(body) {
  const messages = body?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (last?.role !== ROLE.USER || !Array.isArray(last.content)) return false;
  if (!last.content.some((block) => block?.type === CLAUDE_BLOCK.TOOL_RESULT)) return false;
  if (last.content.some((block) => block?.cache_control)) return false;
  if (countCacheControlBlocks(body) >= 4) return false;
  return markLastCacheableBlock(last);
}

// Re-anchor cache breakpoints on a Claude passthrough body (same policy as
// prepareClaudeRequest): last tool + last system block at 1h, last assistant at 5m.
// The client's own markers point at pre-normalization offsets, so they are dropped.
// Must run LAST, after every step that can reshape system/tools/messages
// (normalize, tool dedupe, token savers) — otherwise the anchor drifts off the tail.
export function anchorClaudeCache(body) {
  if (!body || typeof body !== "object") return body;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) normalizeMessageContent(msg);
  }

  if (Array.isArray(body.system)) {
    const last = body.system.length - 1;
    body.system.forEach((block, i) => {
      if (typeof block !== "object" || block === null) return;
      if (i === last) block.cache_control = { ...CACHE_CONTROL_1H };
      else delete block.cache_control;
    });
  }

  if (Array.isArray(body.tools)) {
    const last = lastCacheableToolIndex(body.tools);
    body.tools.forEach((tool, i) => {
      if (i === last) tool.cache_control = { ...CACHE_CONTROL_1H };
      else delete tool.cache_control;
    });
  }

  if (Array.isArray(body.messages)) {
    let anchored = null;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) delete block.cache_control;

      // Prefer the last assistant turn: it ends a completed exchange, so the
      // prefix up to it stays byte-stable across the following requests.
      if (anchored || msg.role !== ROLE.ASSISTANT) continue;
      anchored = markLastCacheableBlock(msg);
    }

    // First turn of a conversation has no assistant yet — anchor the final
    // message instead, so the opening prompt is cached rather than paid twice.
    if (!anchored) {
      for (let i = body.messages.length - 1; i >= 0 && !anchored; i--) {
        anchored = markLastCacheableBlock(body.messages[i]);
      }
    }

    // ...and a tool loop's final tool results, so the next step reads them.
    markFinalToolResults(body);
  }

  return body;
}

// Anthropic itself reads images inside tool_result; other Anthropic-compatible
// endpoints (OpenCode Go, Kimi, DeepSeek, GLM, MiniMax) accept image blocks only
// as user content and silently drop them inside a tool result. Move a tool's
// screenshot out of the result and into the same user turn, after the results.
export function hoistToolResultImages(body) {
  if (!Array.isArray(body?.messages)) return body;
  let touched = false;
  const messages = body.messages.map((msg) => {
    if (msg?.role !== ROLE.USER || !Array.isArray(msg.content)) return msg;
    const hoisted = [];
    const content = msg.content.map((block) => {
      if (block?.type !== CLAUDE_BLOCK.TOOL_RESULT || !Array.isArray(block.content)) return block;
      const images = block.content.filter((c) => c?.type === CLAUDE_BLOCK.IMAGE);
      if (!images.length) return block;
      const rest = block.content.filter((c) => c?.type !== CLAUDE_BLOCK.IMAGE);
      hoisted.push({ type: CLAUDE_BLOCK.TEXT, text: `[Image from tool result ${block.tool_use_id}]` }, ...images);
      return { ...block, content: rest.length ? rest : [{ type: CLAUDE_BLOCK.TEXT, text: "(image attached below)" }] };
    });
    if (!hoisted.length) return msg;
    touched = true;
    // tool_result blocks must lead a user message; the hoisted images follow them.
    return { ...msg, content: [...content, ...hoisted] };
  });
  return touched ? { ...body, messages } : body;
}

// Prepare request for Claude format endpoints
// - Cleanup cache_control
// - Filter empty messages
// - Add thinking block for Anthropic endpoint (provider === "claude")
// - Fix tool_use/tool_result ordering
// - Apply cloaking (billing header + fake user ID) for OAuth tokens
export function prepareClaudeRequest(body, provider = null, apiKey = null, connectionId = null, rawHeaders = null, sessionId = null, credentialId = null) {
  // quirk: MiniMax's Claude-compatible endpoint rejects Anthropic's output_config (400 invalid params)
  if (PROVIDERS[provider]?.quirks?.dropOutputConfig) {
    delete body.output_config;
  }

  // Claude Code puts a `context_management` block (context-editing strategy) in
  // every request; only Anthropic accepts it — gateways fronting other engines
  // answer 400 "context_management: Extra inputs are not permitted". Same-format
  // claude→claude requests skip body rebuilding in the translator, so the field
  // rides through to every non-Anthropic provider on the Claude transport.
  const isAnthropicServing = provider === "claude" || provider?.startsWith?.("anthropic-compatible-");
  if (!isAnthropicServing) {
    delete body.context_management;
  }

  // Models whose API rejects thinking "disabled" and forced tool use with a 400
  // (Sonnet 5.5). Runs on every Claude-bound body, so OpenAI clients, native
  // passthrough and the provider-level "off" override are all covered.
  const offCaps = getCapabilitiesForModel(provider, body.model);
  if (offCaps.thinkingOffType && body.thinking?.type === "disabled") {
    body.thinking = { type: offCaps.thinkingOffType };
    // between_tools only accepts effort up to high.
    const effort = body.output_config?.effort;
    if (effort === "xhigh" || effort === "max") body.output_config.effort = "high";
  }
  if (offCaps.forcedToolChoice === false && (body.tool_choice?.type === "any" || body.tool_choice?.type === "tool")) {
    const { disable_parallel_tool_use } = body.tool_choice;
    body.tool_choice = { type: "auto", ...(disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use } : {}) };
  }

  // Clamp max_tokens to the model's real output ceiling. Models whose caps
  // declare a higher maxOutput (e.g. Opus 4.8 / Sonnet 4.6 = 128000) are allowed
  // up to it, so max-effort thinking gets full budget; others fall back to the
  // conservative 64000 default.
  if (body.max_tokens) {
    const ceiling = getCapabilitiesForModel(provider, body.model).maxOutput || DEFAULT_MAX_TOKENS;
    if (body.max_tokens > ceiling) body.max_tokens = ceiling;

    // Reconcile against thinking budget. applyThinking (thinkingUnified.js) runs
    // AFTER adjustMaxTokens capped max_tokens, and the claude-budget format maps
    // max effort → budget_tokens 128000 — larger than the clamped max_tokens.
    // Anthropic requires max_tokens strictly greater than budget_tokens (else 400).
    // Prefer raising max_tokens to preserve the requested thinking depth; if the
    // budget alone meets/exceeds the ceiling, cap output and shrink the budget so
    // some tokens remain for the answer.
    if (body.thinking?.type === "enabled" && body.thinking.budget_tokens && body.thinking.budget_tokens >= body.max_tokens) {
      body.max_tokens = Math.min(body.thinking.budget_tokens + 1024, ceiling);
      if (body.thinking.budget_tokens >= body.max_tokens) {
        body.thinking.budget_tokens = Math.max(1024, body.max_tokens - 1024);
      }
    }
  }

  // 1. System: remove all cache_control, add only to last block with ttl 1h
  if (body.system && Array.isArray(body.system)) {
    body.system = body.system.map((block, i) => {
      const { cache_control, ...rest } = block;
      if (i === body.system.length - 1) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });
  }

  // 2. Messages: process in optimized passes
  if (body.messages && Array.isArray(body.messages)) {
    // Promote lingering system/developer messages out of messages[] into top-level
    // system. Anthropic rejects role:'system' in messages[]. Safety net for
    // passthrough + translation edge cases (Switchboard PR#1600 / #1580).
    const systemTexts = [];
    body.messages = body.messages.filter(msg => {
      if (msg.role === "system" || msg.role === "developer") {
        const text = typeof msg.content === "string" ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
        if (text.trim()) systemTexts.push(text);
        return false;
      }
      return true;
    });
    if (systemTexts.length > 0) {
      const promoted = { type: "text", text: systemTexts.join("\n") };
      if (Array.isArray(body.system)) {
        body.system = [...body.system, promoted];
      } else if (typeof body.system === "string" && body.system.length > 0) {
        body.system = [{ type: "text", text: body.system }, promoted];
      } else {
        body.system = [promoted];
      }
    }

    const len = body.messages.length;
    const originalLastRole = body.messages[len - 1]?.role;
    let filtered = [];

    // Pass 1: remove cache_control + filter empty messages
    for (let i = 0; i < len; i++) {
      const msg = body.messages[i];
      normalizeMessageContent(msg);

      // Remove cache_control from content blocks
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          delete block.cache_control;
        }
      }

      // Keep final assistant even if empty, otherwise check valid content
      const isFinalAssistant = i === len - 1 && msg.role === "assistant";
      if (isFinalAssistant || hasValidContent(msg)) {
        filtered.push(msg);
      }
    }

    // Pass 1.5: Fix tool_use/tool_result ordering
    // Each tool_use must have tool_result in the NEXT message (not same message with other content)
    filtered = fixToolUseOrdering(filtered);
    filtered = ensureTrailingUserTurn(filtered, originalLastRole);

    body.messages = filtered;

    // Check if thinking is enabled AND last message is from user
    const lastMessage = filtered[filtered.length - 1];
    const lastMessageIsUser = lastMessage?.role === "user";
    const thinkingEnabled = body.thinking?.type === "enabled" && lastMessageIsUser;
    // DeepSeek models behind OpenCode Go's /messages transport carry the same
    // thinking pass-back constraint as the official DeepSeek provider (400
    // "content[].thinking in the thinking mode must be passed back"), so they
    // get the identical keep/unsigned-placeholder handling below.
    const deepSeekServed = provider === "deepseek"
      || (provider === "opencode-go" && isDeepSeekModel(body?.model));

    // Pass 2 (reverse): add cache_control to last assistant + handle thinking for Anthropic
    let lastAssistantProcessed = false;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Add cache_control to last non-thinking block of first (from end) assistant with content
        // thinking/redacted_thinking blocks do not support cache_control
        if (!lastAssistantProcessed && msg.content.length > 0) {
          for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type !== CLAUDE_BLOCK.THINKING && block.type !== CLAUDE_BLOCK.REDACTED_THINKING) {
              block.cache_control = { type: "ephemeral" };
              break;
            }
          }
          lastAssistantProcessed = true;
        }

        // Handle thinking blocks for Anthropic-compatible endpoints.
        if (handlesThinkingBlocks(provider) || deepSeekServed) {
          let hasToolUse = false;
          let hasKeptThinking = false;

          // Claude native: preserve valid signatures, drop invalid blocks.
          // anthropic-compatible: replace with default (safe fallback for lenient upstreams).
          // DeepSeek: keep existing thinking as-is; add an unsigned placeholder only if missing.
          // Every branch: a block with no visible thinking text goes — the upstream
          // Messages API rejects it outright (400 "each thinking block must contain
          // non-whitespace thinking"), and a valid signature does not save it.
          const isClaudeNative = provider === "claude";
          const isDeepSeek = deepSeekServed;
          const kept = [];
          for (const block of msg.content) {
            const isThinking = block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING;
            if (isThinking) {
              if (block.type === CLAUDE_BLOCK.THINKING && !String(block.thinking ?? "").trim()) continue;
              if (isClaudeNative) {
                if (isReusableClaudeThinkingBlock(block)) {
                  hasKeptThinking = true;
                  kept.push(block);
                }
              } else if (isDeepSeek) {
                hasKeptThinking = true;
                kept.push(block);
              } else {
                // The signature fallback applies only to regular thinking.
                // Redacted blocks must keep their original encrypted data shape.
                if (block.type === CLAUDE_BLOCK.THINKING) {
                  block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
                }
                hasKeptThinking = true;
                kept.push(block);
              }
              continue;
            }
            if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
            kept.push(block);
          }
          msg.content = kept;

          // Add thinking block if thinking enabled + has tool_use but no thinking
          if (thinkingEnabled && !hasKeptThinking && hasToolUse) {
            msg.content.unshift(buildThinkingPlaceholder(provider, deepSeekServed));
          }
        }
      }
    }
  }

  // 3. Tools: filter built-in tools for non-Anthropic providers, then handle cache_control
  if (body.tools && Array.isArray(body.tools)) {
    // Strip built-in tools (e.g. web_search_20250305) and normalize to Anthropic-native shape
    // (fold `function.{name,description,parameters}`) for non-Anthropic providers.
    // IMPORTANT: default type to "custom" — strict Anthropic-compatible gateways
    // (MiniMax) reject tools without type (code 2013). Switchboard#2195 / #1939.
    if (provider !== "claude") {
      // Some Anthropic-compatible gateways whitelist the tool `type` enum.
      // DeepSeek's /anthropic/v1/messages accepts only web_search_* built-ins
      // and answers HTTP 400 "unknown variant `custom`" to typed client tools,
      // but accepts the legacy typeless shape. Under that quirk, keep the
      // whitelisted built-ins as-is and send client tools without `type`.
      const supportedTypes = PROVIDERS[provider]?.quirks?.claudeSupportedToolTypes;
      const hasWhitelist = Array.isArray(supportedTypes);
      const isClientTool = tool => !tool.type || tool.type === "function" || tool.type === "custom";
      body.tools = body.tools
        .filter(tool => isClientTool(tool) || (hasWhitelist && supportedTypes.includes(tool.type)))
        .map(tool => {
          if (hasWhitelist && !isClientTool(tool)) return tool;
          if (tool.function) {
            return {
              ...(hasWhitelist ? {} : { type: "custom" }),
              name: tool.function.name,
              description: typeof tool.function.description === "string" ? tool.function.description : String(tool.function.description || ""),
              input_schema: tool.function.parameters || tool.function.input_schema || { type: "object", properties: {} },
            };
          }
          const { type, ...rest } = tool;
          return {
            ...(hasWhitelist ? {} : { type: type && type !== "function" ? type : "custom" }),
            ...rest,
            description: typeof rest.description === "string" ? rest.description : String(rest.description || ""),
          };
        });
    } else {
      // Official Anthropic: still default missing type to custom for legacy clients
      body.tools = body.tools.map(tool => {
        if (tool.function) {
          return {
            type: "custom",
            name: tool.function.name,
            description: tool.function.description || "",
            input_schema: tool.function.parameters || { type: "object", properties: {} },
          };
        }
        if (!tool.type) return { ...tool, type: "custom" };
        return tool;
      });
    }

    const lastCacheable = lastCacheableToolIndex(body.tools);
    body.tools = body.tools.map((tool, i) => {
      const { cache_control, ...rest } = tool;
      if (i === lastCacheable) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });

    // Remove tools array and tool_choice if empty after filtering
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }

  // Anthropic's own endpoints (claude OAuth, anthropic API key, anthropic-compatible
  // nodes in front of Anthropic) read images inside tool_result natively.
  if (provider !== "claude" && provider !== "anthropic" && !provider?.startsWith("anthropic-compatible")) {
    body = hoistToolResultImages(body);
  }

  // A tool loop's final tool results: cached now, so the next step reads them.
  markFinalToolResults(body);

  // Apply cloaking for OAuth tokens (billing header + fake user ID)
  // session_id in user_id must match X-Claude-Code-Session-Id for fingerprint consistency
  if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
    const sid = sessionId || resolveSessionId({ headers: rawHeaders, body, connectionId, scope: "claude" });
    body = applyCloaking(body, apiKey, sid, credentialId || connectionId || apiKey);
  }

  return body;
}
