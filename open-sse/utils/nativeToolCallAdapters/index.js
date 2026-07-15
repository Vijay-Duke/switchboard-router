/**
 * Native Tool Call Adapter Registry
 *
 * Some models (DeepSeek, Composer, etc.) emit tool calls using their own native
 * token format embedded in text content, rather than using the provider's
 * structured tool_calls mechanism. This module provides a pluggable adapter
 * pattern to detect and parse those native tokens into standard OpenAI tool_calls.
 *
 * To add a new adapter:
 *   1. Create a new file in this directory (e.g., myModel.js)
 *   2. Export an object with: { name, detect(text), parse(text) }
 *   3. Register it below with a model pattern
 */

import { deepseekAdapter } from "./deepseek.js";

// ─── Adapter Interface ───────────────────────────────────────────────────────
//
// Each adapter must implement:
//
//   name: string
//     Human-readable identifier for logging.
//
//   detect(text: string): boolean
//     Returns true if the text contains this adapter's native tool-call tokens.
//     Should be fast — called on every response text.
//
//   parse(text: string): { content: string|null, toolCalls: ToolCall[] }
//     Extracts tool calls from the text. Returns:
//       - content: the remaining text after stripping tool-call tokens (null if empty)
//       - toolCalls: array of { id, type, function: { name, arguments } }
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry entries: [modelPattern, adapter]
 * modelPattern is a RegExp tested against the model string (case-insensitive).
 * Order matters — first match wins.
 */
const ADAPTER_REGISTRY = [
  // DeepSeek-family models (DeepSeek V3/V4, Composer 2.x which is DeepSeek-based)
  [/deepseek|composer/i, deepseekAdapter],
];

/**
 * Find the appropriate adapter for a given model name.
 * @param {string} model - The model identifier (e.g., "cu/composer-2.5", "deepseek-chat")
 * @returns {object|null} The adapter, or null if no adapter matches.
 */
export function getAdapterForModel(model) {
  if (!model) return null;
  for (const [pattern, adapter] of ADAPTER_REGISTRY) {
    if (pattern.test(model)) return adapter;
  }
  return null;
}

/**
 * Attempt to extract native tool calls from accumulated text content.
 * This is the main entry point used by the response pipeline.
 *
 * @param {string} text - The accumulated response text content
 * @param {string} model - The model identifier
 * @returns {{ content: string|null, toolCalls: Array }|null}
 *   Returns null if no adapter matches or no native tokens detected.
 *   Otherwise returns parsed result with cleaned content and extracted tool calls.
 */
export function extractNativeToolCalls(text, model) {
  if (!text || !model) return null;

  const adapter = getAdapterForModel(model);
  if (!adapter) return null;

  if (!adapter.detect(text)) return null;

  return adapter.parse(text);
}

/**
 * Register a custom adapter at runtime (e.g., for plugins or testing).
 * @param {RegExp} pattern - Model name pattern to match
 * @param {object} adapter - Adapter implementing { name, detect, parse }
 * @param {{ prepend?: boolean }} options - If prepend=true, insert at start (higher priority)
 */
export function registerAdapter(pattern, adapter, { prepend = false } = {}) {
  if (!pattern || !adapter || !adapter.detect || !adapter.parse) {
    throw new Error("Adapter must implement detect(text) and parse(text)");
  }
  if (prepend) {
    ADAPTER_REGISTRY.unshift([pattern, adapter]);
  } else {
    ADAPTER_REGISTRY.push([pattern, adapter]);
  }
}
