/**
 * Singleton cache for real Claude Code client headers.
 * Captures headers from authentic Claude Code requests and makes them available
 * for forwarding to api.anthropic.com, replacing static hardcoded values.
 */

import { isConfirmedClaudeClient } from "./clientDetector.js";

const CLAUDE_IDENTITY_HEADERS = [
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-claude-code-session-id",
  "package-version",
  "runtime-version",
  "os",
  "arch",
];

let cachedHeaders = null;

/**
 * Select only non-secret Claude Code identity/capability headers.
 * @param {object} headers
 * @returns {object|null}
 */
export function pickClaudeIdentityHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const captured = {};
  for (const key of CLAUDE_IDENTITY_HEADERS) {
    if (headers[key] !== undefined && headers[key] !== null) captured[key] = headers[key];
  }
  return Object.keys(captured).length > 0 ? captured : null;
}


/**
 * Store Claude Code identity headers only after the full client signature is confirmed.
 * Called at the entry point before any translation/forwarding.
 * @param {object} headers - Lowercase header key/value object (from request.headers.entries())
 * @param {object} body - Parsed request body
 */
export function cacheClaudeHeaders(headers, body = {}) {
  if (!isConfirmedClaudeClient(headers, body)) return false;
  const captured = pickClaudeIdentityHeaders(headers);
  if (!captured) return false;
  cachedHeaders = captured;
  console.log(`[ClaudeHeaders] Cached ${Object.keys(captured).length} identity headers from confirmed Claude Code client`);
  return true;
}

/**
 * Get the most recently cached Claude Code identity headers.
 * Returns null if no authentic client request has been seen yet (cold start).
 * @returns {object|null}
 */
export function getCachedClaudeHeaders() {
  return cachedHeaders;
}
